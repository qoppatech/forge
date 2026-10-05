import { bytesToHex } from "./bytes.js";

/** Converts bigint → decimal string and bytes → hex so values survive JSON and jsonb. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return value;
}

/** Canonical JSON (sorted keys) used for request hashing and intent comparison. */
export function stableStringify(value: unknown): string {
  const safe = toJsonSafe(value);
  const walk = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${walk(item)}`).join(",")}}`;
    }
    return JSON.stringify(v);
  };
  return walk(safe);
}

export function intentsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
