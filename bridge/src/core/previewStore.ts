/**
 * Two-step write gate. Every tool that writes to Revit must first run in
 * preview mode, which records a fingerprint of the request and a hash of the
 * exact payload that would be sent. `apply: true` must quote the previewId;
 * the tool recomputes the payload from live data and refuses to write unless
 * both the request fingerprint and the payload hash still match. A preview is
 * single-use and expires.
 */

import { createHash, randomUUID } from "node:crypto";

export interface PreviewRecord {
  id: string;
  tool: string;
  requestFingerprint: string;
  payloadHash: string;
  createdAt: number;
  expiresAt: number;
}

/** Canonical JSON: object keys sorted recursively so hashes are stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export function hashOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Fingerprint of tool arguments, ignoring the gate fields themselves. */
export function requestFingerprint(args: Record<string, unknown>): string {
  const { apply: _a, previewId: _p, ...rest } = args;
  return hashOf(rest);
}

export class PreviewStore {
  private readonly records = new Map<string, PreviewRecord>();

  constructor(
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(tool: string, args: Record<string, unknown>, payload: unknown): PreviewRecord {
    this.prune();
    const t = this.now();
    const rec: PreviewRecord = {
      id: randomUUID(),
      tool,
      requestFingerprint: requestFingerprint(args),
      payloadHash: hashOf(payload),
      createdAt: t,
      expiresAt: t + this.ttlMs,
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  /**
   * Validate an apply request. Returns null when OK, else a human-readable
   * refusal. Does NOT consume; call consume() after a successful write.
   */
  check(tool: string, args: Record<string, unknown>, previewId: string | undefined, payload: unknown): string | null {
    this.prune();
    if (!previewId) {
      return `apply requires previewId. Run ${tool} without apply first, review the preview, then call again with apply: true and the returned previewId.`;
    }
    const rec = this.records.get(previewId);
    if (!rec) return `previewId '${previewId}' is unknown, expired or already used. Run a fresh preview.`;
    if (rec.tool !== tool) return `previewId '${previewId}' belongs to ${rec.tool}, not ${tool}.`;
    if (rec.requestFingerprint !== requestFingerprint(args)) {
      return "The arguments differ from the previewed request. Run a fresh preview with these arguments.";
    }
    if (rec.payloadHash !== hashOf(payload)) {
      return "The data to be written changed since the preview (Civil 3D or Revit state moved). Run a fresh preview and review it again.";
    }
    return null;
  }

  consume(previewId: string): void {
    this.records.delete(previewId);
  }

  get size(): number {
    this.prune();
    return this.records.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, r] of this.records) if (r.expiresAt <= t) this.records.delete(id);
  }
}
