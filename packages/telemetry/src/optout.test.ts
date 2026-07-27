import { describe, expect, test } from "bun:test";
import {
  applyDefaultOn,
  consentGeneration,
  fromLegacyBoolean,
  isSendPermitted,
  parseConsent,
  unsetConsent,
  userConsent,
} from "./optout.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const T1 = Date.parse("2026-02-01T00:00:00.000Z");

describe("consent provenance", () => {
  test("unset never sends", () => {
    const state = unsetConsent(T0);
    expect(state).toEqual({ enabled: false, source: "unset", decided_at: "2026-01-01T00:00:00.000Z" });
    expect(isSendPermitted(state)).toBe(false);
  });

  test("an enabled state with source unset STILL does not send — nobody decided", () => {
    expect(isSendPermitted({ enabled: true, source: "unset", decided_at: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  test("a user decision sends when enabled and not when disabled", () => {
    expect(isSendPermitted(userConsent(true, T0))).toBe(true);
    expect(isSendPermitted(userConsent(false, T0))).toBe(false);
  });
});

describe("applyDefaultOn — ONLY 'unset' may be flipped on", () => {
  test("flips unset", () => {
    const migrated = applyDefaultOn(unsetConsent(T0), T1);
    expect(migrated).toEqual({ enabled: true, source: "default-on", decided_at: "2026-02-01T00:00:00.000Z" });
    expect(isSendPermitted(migrated)).toBe(true);
  });

  test("NEVER overwrites a user opt-out", () => {
    const optedOut = userConsent(false, T0);
    expect(applyDefaultOn(optedOut, T1)).toEqual(optedOut);
    expect(isSendPermitted(applyDefaultOn(optedOut, T1))).toBe(false);
  });

  test("never overwrites a user opt-IN either — the decision and its timestamp stand", () => {
    const optedIn = userConsent(true, T0);
    expect(applyDefaultOn(optedIn, T1)).toEqual(optedIn);
  });

  test("is idempotent — re-running does not churn decided_at (the transport fences on it)", () => {
    const once = applyDefaultOn(unsetConsent(T0), T0);
    const twice = applyDefaultOn(once, T1);
    expect(twice).toEqual(once);
    expect(consentGeneration(twice)).toBe(consentGeneration(once));
  });
});

describe("fromLegacyBoolean", () => {
  test("a legacy false is treated as a USER opt-out by default (the conservative reading)", () => {
    const state = fromLegacyBoolean(false, T0);
    expect(state.source).toBe("user");
    expect(applyDefaultOn(state, T1)).toEqual(state);
  });

  test("the caller may opt into the other reading explicitly", () => {
    const state = fromLegacyBoolean(false, T0, { treatDisabledAs: "unset" });
    expect(state.source).toBe("unset");
    expect(applyDefaultOn(state, T1).enabled).toBe(true);
  });

  test("a legacy true carries default-on provenance", () => {
    expect(fromLegacyBoolean(true, T0).source).toBe("default-on");
  });
});

describe("parseConsent", () => {
  test("round-trips a valid document", () => {
    const state = userConsent(true, T0);
    expect(parseConsent(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  test("rejects anything unrecognised rather than guessing a permissive default", () => {
    expect(parseConsent(undefined)).toBeUndefined();
    expect(parseConsent(null)).toBeUndefined();
    expect(parseConsent("true")).toBeUndefined();
    expect(parseConsent({ enabled: true })).toBeUndefined();
    expect(parseConsent({ enabled: true, source: "admin", decided_at: "2026-01-01T00:00:00.000Z" })).toBeUndefined();
    expect(parseConsent({ enabled: true, source: "user", decided_at: "whenever" })).toBeUndefined();
    expect(parseConsent({ enabled: "yes", source: "user", decided_at: "2026-01-01T00:00:00.000Z" })).toBeUndefined();
  });
});

describe("consentGeneration", () => {
  test("changes whenever the decision changes", () => {
    const a = consentGeneration(userConsent(true, T0));
    expect(consentGeneration(userConsent(false, T0))).not.toBe(a);
    expect(consentGeneration(userConsent(true, T1))).not.toBe(a);
    expect(consentGeneration({ enabled: true, source: "default-on", decided_at: "2026-01-01T00:00:00.000Z" })).not.toBe(a);
  });
});
