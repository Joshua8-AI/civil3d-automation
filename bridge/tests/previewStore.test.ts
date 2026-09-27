import { describe, expect, it } from "vitest";
import { canonicalJson, hashOf, PreviewStore, requestFingerprint } from "../src/core/previewStore.js";

describe("canonical hashing", () => {
  it("is insensitive to key order and undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1, e: undefined }));
    expect(hashOf({ x: [1, 2] })).not.toBe(hashOf({ x: [2, 1] }));
  });
  it("fingerprint ignores apply and previewId", () => {
    expect(requestFingerprint({ a: 1, apply: true, previewId: "p" })).toBe(requestFingerprint({ a: 1, apply: false }));
  });
});

describe("PreviewStore", () => {
  const args = { surfaceName: "FG", maxPoints: 100 };
  const payload = { points: [1, 2, 3] };

  it("accepts a matching apply once", () => {
    const s = new PreviewStore();
    const r = s.record("t", args, payload);
    expect(s.check("t", { ...args, apply: true, previewId: r.id }, r.id, payload)).toBeNull();
    s.consume(r.id);
    expect(s.check("t", args, r.id, payload)).toMatch(/unknown, expired or already used/);
  });

  it("requires a previewId", () => {
    expect(new PreviewStore().check("t", args, undefined, payload)).toMatch(/requires previewId/);
  });

  it("rejects changed arguments, changed payload, or another tool", () => {
    const s = new PreviewStore();
    const r = s.record("t", args, payload);
    expect(s.check("t", { ...args, maxPoints: 101 }, r.id, payload)).toMatch(/arguments differ/);
    expect(s.check("t", args, r.id, { points: [1, 2, 4] })).toMatch(/changed since the preview/);
    expect(s.check("other", args, r.id, payload)).toMatch(/belongs to t/);
  });

  it("expires", () => {
    let now = 1000;
    const s = new PreviewStore(500, () => now);
    const r = s.record("t", args, payload);
    now = 1499;
    expect(s.check("t", args, r.id, payload)).toBeNull();
    now = 1500;
    expect(s.check("t", args, r.id, payload)).toMatch(/expired/);
    expect(s.size).toBe(0);
  });
});
