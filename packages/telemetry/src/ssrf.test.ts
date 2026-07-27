import { afterAll, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { blockedAddressReason, EndpointRejected, isLoopbackAddress, postPinned, resolveAndPin } from "./ssrf.ts";

// ── address classification ─────────────────────────────────────────────────────────────────

describe("blockedAddressReason", () => {
  const BLOCKED = [
    // IPv4
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "169.254.169.254", // the cloud metadata endpoint
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.5",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.7",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6
    "::",
    "::1",
    "fc00::1",
    "fd12:3456:789a::1", // ULA — a compose network
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    // embedded IPv4 forms
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.0.1",
    "::127.0.0.1",
    "64:ff9b::127.0.0.1",
    "64:ff9b::a00:1",
    "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
    "2002:a00:1::", // 6to4 wrapping 10.0.0.1
    // The embedded-IPv4 spellings that were NOT caught until the final review. Each is accepted
    // by net.isIP as an ordinary IPv6 address, so each reaches the classifier as a literal host
    // AND as a resolver answer; each classified as public before these were added.
    "::ffff:0:127.0.0.1", // IPv4-translated ::ffff:0:0:0/96 — the mapped form one group over
    "::ffff:0:10.0.0.5",
    "::ffff:0:169.254.169.254", // cloud metadata through the translated spelling
    "::ffff:0:7f00:1", // …and the same address written without the dotted tail
    "64:ff9b:1::7f00:1", // RFC 8215 local-use NAT64, outside the well-known /96
    "64:ff9b:1::a00:5",
    "64:ff9b:1:2:3:4:5:6", // anywhere in the /32 — no embedding to decode, refused wholesale
    "2001::1", // Teredo 2001::/32
    "2001:0:53aa:64c:1c:7b7f:5f3c:8b8c", // a realistic Teredo address
  ];

  for (const address of BLOCKED) {
    test(`blocks ${address}`, () => {
      expect(blockedAddressReason(address)).toBeDefined();
    });
  }

  const ALLOWED = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "100.63.255.255",
    "2606:4700::1111",
    "2a00:1450:4001:80e::200e",
    // Guards the widened prefixes against over-blocking: these are real public IPv6 addresses
    // that share leading bytes with the transition prefixes refused above and must still pass.
    "2001:4860:4860::8888", // 2001:4860::/32 — public, and NOT Teredo's 2001:0000::/32
    "2001:500:200::b", // likewise adjacent to the Teredo prefix
    "64:ff9a::1", // one below the translation allocation
    "65:ff9b::1", // one above it
  ];

  for (const address of ALLOWED) {
    test(`allows public ${address}`, () => {
      expect(blockedAddressReason(address)).toBeUndefined();
    });
  }

  test("an unparseable address is blocked, not passed through", () => {
    expect(blockedAddressReason("not-an-address")).toBe("unparseable address");
    expect(blockedAddressReason("999.1.1.1")).toBeDefined();
    expect(blockedAddressReason("")).toBeDefined();
  });

  test("isLoopbackAddress covers v4, v6 and the IPv4-mapped form", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.9.9.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("1.1.1.1")).toBe(false);
  });
});

// ── endpoint policy ────────────────────────────────────────────────────────────────────────

const publicLookup = async (): Promise<Array<{ address: string; family: number }>> => [{ address: "93.184.216.34", family: 4 }];

async function reasonFor(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "<no rejection>";
  } catch (err) {
    return err instanceof EndpointRejected ? err.reason : `unexpected: ${String(err)}`;
  }
}

describe("resolveAndPin — policy", () => {
  test("https to a public address passes and is pinned to that address", async () => {
    const pinned = await resolveAndPin("https://collector.example.com/v1/ingest", { lookup: publicLookup });
    expect(pinned.address).toBe("93.184.216.34");
    expect(pinned.family).toBe(4);
    expect(pinned.literal).toBe(false);
    expect(pinned.url.hostname).toBe("collector.example.com");
  });

  test("http is refused without the explicit loopback opt-in", async () => {
    expect(await reasonFor(() => resolveAndPin("http://collector.example.com", { lookup: publicLookup }))).toBe("https_required");
  });

  test("the http opt-in unlocks ONLY loopback — not a public address", async () => {
    expect(
      await reasonFor(() => resolveAndPin("http://collector.example.com", { allowInsecureLoopback: true, lookup: publicLookup })),
    ).toBe("https_required");
  });

  test("the http opt-in works for a loopback literal", async () => {
    const pinned = await resolveAndPin("http://127.0.0.1:9999/v1/ingest", {
      allowInsecureLoopback: true,
      allowPrivateAddresses: true,
    });
    expect(pinned.address).toBe("127.0.0.1");
    expect(pinned.literal).toBe(true);
  });

  test("a private/loopback/link-local resolution is blocked", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fd00::1", "::ffff:192.168.1.1"]) {
      const reason = await reasonFor(() =>
        resolveAndPin("https://collector.example.com", { lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] }),
      );
      expect(reason).toBe("address_blocked");
    }
  });

  test("EVERY answer must pass — a round-robin name mixing public and private is refused", async () => {
    const reason = await reasonFor(() =>
      resolveAndPin("https://rebind.example.com", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    );
    expect(reason).toBe("address_blocked");
  });

  test("an IP literal in the URL is judged directly, with no DNS at all", async () => {
    let called = false;
    const reason = await reasonFor(() =>
      resolveAndPin("https://10.0.0.1/v1/ingest", {
        lookup: async () => {
          called = true;
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    );
    expect(reason).toBe("address_blocked");
    expect(called).toBe(false);
  });

  test("localhost and internal namespaces are refused by name", async () => {
    for (const host of ["localhost", "collector.local", "db.internal", "printer.home.arpa"]) {
      expect(await reasonFor(() => resolveAndPin(`https://${host}/x`, { lookup: publicLookup }))).toBe("host_not_routable");
    }
  });

  test("non-http(s) schemes, credentials and junk are refused", async () => {
    expect(await reasonFor(() => resolveAndPin("file:///etc/passwd"))).toBe("scheme_not_allowed");
    expect(await reasonFor(() => resolveAndPin("gopher://evil.example.com"))).toBe("scheme_not_allowed");
    expect(await reasonFor(() => resolveAndPin("https://user:pw@collector.example.com", { lookup: publicLookup }))).toBe(
      "credentials_in_url",
    );
    expect(await reasonFor(() => resolveAndPin("not a url"))).toBe("invalid_url");
  });

  test("a name that resolves to nothing, or fails to resolve, is refused", async () => {
    expect(await reasonFor(() => resolveAndPin("https://x.example.com", { lookup: async () => [] }))).toBe("dns_empty");
    expect(
      await reasonFor(() =>
        resolveAndPin("https://x.example.com", {
          lookup: async () => {
            throw new Error("NXDOMAIN");
          },
        }),
      ),
    ).toBe("dns_failed");
  });

  test("allowPrivateAddresses is an explicit, never-inferred escape hatch", async () => {
    const pinned = await resolveAndPin("https://collector.internal/x", {
      allowPrivateAddresses: true,
      lookup: async () => [{ address: "10.1.2.3", family: 4 }],
    });
    expect(pinned.address).toBe("10.1.2.3");
  });
});

// ── the pinned request ─────────────────────────────────────────────────────────────────────

const servers: http.Server[] = [];

function serve(handler: http.RequestListener): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port }));
  });
}

afterAll(() => {
  for (const server of servers) server.close();
});

async function pinnedTo(port: number, host = "collector.example.com"): ReturnType<typeof resolveAndPin> {
  return resolveAndPin(`http://${host}:${port}/v1/ingest`, {
    allowInsecureLoopback: true,
    allowPrivateAddresses: true,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
}

describe("postPinned", () => {
  test("connects to the PINNED address while keeping the configured hostname — no second resolution", async () => {
    let seenHost = "";
    let seenBody = "";
    let seenKey = "";
    const { port } = await serve((req, res) => {
      seenHost = req.headers.host ?? "";
      seenKey = String(req.headers["x-mythical-write-key"] ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(202);
        res.end("accepted");
      });
    });

    // The hostname is NOT resolvable. The request can only succeed via the pinned address, which
    // is exactly the property that closes the DNS-rebinding window.
    const endpoint = await pinnedTo(port, "definitely-not-resolvable.invalid");
    const result = await postPinned({
      endpoint,
      body: '{"hello":"world"}',
      headers: { "content-type": "application/json", "X-Mythical-Write-Key": "s3cr3t" },
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(seenHost).toBe(`definitely-not-resolvable.invalid:${port}`);
    expect(seenBody).toBe('{"hello":"world"}');
    expect(seenKey).toBe("s3cr3t");
  });

  test("a non-2xx surfaces the STATUS and nothing else", async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("schema_version 2 not supported");
    });
    const result = await postPinned({ endpoint: await pinnedTo(port), body: "{}", headers: {}, timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    // No field carries anything the endpoint chose. The status is the actionable signal, and it
    // is a number, so there is no encoding a hostile endpoint can hide a secret in.
    expect(Object.keys(result).sort()).toEqual(["ok", "status"]);
  });

  test("NOTHING the endpoint says is returned, whatever it says", async () => {
    const secret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    // Every spelling that defeated a previous generation of content filtering, at once.
    const spellings = [secret, secret.match(/.{1,8}/g)!.join("-"), secret.split("").join("Z"), secret.split("").map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join("")];
    const { port } = await serve((_req, res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(spellings.join(" "));
    });
    const result = await postPinned({
      endpoint: await pinnedTo(port),
      body: "{}",
      headers: { "X-Mythical-Write-Key": secret },
      timeoutMs: 2000,
    });
    // The class is removed, not filtered: there is no string field for any spelling to land in.
    expect(JSON.stringify(result)).not.toContain("a1b2");
    expect(JSON.stringify(result)).toBe(JSON.stringify({ status: 401, ok: false }));
  });

  test("a REDIRECT is not followed — it is surfaced as a rejection", async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    let reason = "";
    try {
      await postPinned({ endpoint: await pinnedTo(port), body: "{}", headers: {}, timeoutMs: 2000 });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("redirect_not_followed");
  });

  test("a SLOW-LORIS endpoint is cut off at the deadline and leaves no socket behind", async () => {
    const held: http.ServerResponse[] = [];
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("a"); // then never finishes
      held.push(res);
    });

    const started = Date.now();
    let reason = "";
    try {
      await postPinned({ endpoint: await pinnedTo(port), body: "{}", headers: {}, timeoutMs: 250 });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    for (const res of held) res.end();
  });

  test("a huge body is drained under a bound and discarded, not buffered", async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("y".repeat(2_000_000));
    });
    const started = Date.now();
    const result = await postPinned({
      endpoint: await pinnedTo(port),
      body: "{}",
      headers: {},
      timeoutMs: 3000,
      maxResponseBytes: 1024,
    });
    expect(result.status).toBe(500);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("an external abort ends the attempt promptly", async () => {
    const held: http.ServerResponse[] = [];
    const { port } = await serve((_req, res) => {
      held.push(res);
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    let reason = "";
    try {
      await postPinned({ endpoint: await pinnedTo(port), body: "{}", headers: {}, timeoutMs: 30_000, signal: controller.signal });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("aborted");
    for (const res of held) res.end();
  });

  test("an already-aborted signal never opens a socket", async () => {
    const { port } = await serve((_req, res) => res.end("no"));
    const controller = new AbortController();
    controller.abort();
    let reason = "";
    try {
      await postPinned({ endpoint: await pinnedTo(port), body: "{}", headers: {}, timeoutMs: 1000, signal: controller.signal });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("aborted");
  });

  test("a connection refused surfaces as a request failure, not a hang", async () => {
    const endpoint = await resolveAndPin("http://collector.example.com:1/v1/ingest", {
      allowInsecureLoopback: true,
      allowPrivateAddresses: true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    let reason = "";
    try {
      await postPinned({ endpoint, body: "{}", headers: {}, timeoutMs: 2000 });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("request_failed");
  });

  test("the query string of a configured endpoint is preserved on the wire", async () => {
    let seenUrl = "";
    const { port } = await serve((req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200);
      res.end("ok");
    });
    const endpoint = await resolveAndPin(`http://collector.example.com:${port}/v1/ingest?tenant=7`, {
      allowInsecureLoopback: true,
      allowPrivateAddresses: true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await postPinned({ endpoint, body: "{}", headers: {}, timeoutMs: 2000 });
    expect(seenUrl).toBe("/v1/ingest?tenant=7");
  });
});

describe("resolution has its own deadline and its own abort hook", () => {
  test("a resolver that never answers is cut off — it must not slip past postPinned's timeout", async () => {
    const started = Date.now();
    let reason = "";
    try {
      await resolveAndPin("https://slow-dns.example.com/x", {
        resolveTimeoutMs: 120,
        lookup: () => new Promise(() => {}), // never settles
      });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("dns_timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("an abort during resolution ends it — a fence must reach a request still waiting on DNS", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    let reason = "";
    try {
      await resolveAndPin("https://slow-dns.example.com/x", {
        resolveTimeoutMs: 30_000,
        signal: controller.signal,
        lookup: () => new Promise(() => {}),
      });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("aborted");
  });

  test("an already-aborted signal never starts resolving", async () => {
    const controller = new AbortController();
    controller.abort();
    let reason = "";
    try {
      await resolveAndPin("https://x.example.com", { signal: controller.signal, lookup: async () => [{ address: "1.1.1.1", family: 4 }] });
    } catch (err) {
      reason = err instanceof EndpointRejected ? err.reason : String(err);
    }
    expect(reason).toBe("aborted");
  });
});

