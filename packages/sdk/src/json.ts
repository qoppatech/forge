import { bytesToHex } from "./bytes.js";

/** Converts bigint → decimal string and bytes → hex so values survive JSON and jsonb. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return bytesToHex(value);
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        toJsonSafe(v),
      ])
    );
  }
  return value;
}

function compareKeys(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(canonicalJson).join(",")}]`;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => compareKeys(a, b));
    return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Canonical JSON (sorted keys) used for request hashing and intent comparison. */
export function stableStringify(value: unknown): string {
  return canonicalJson(toJsonSafe(value));
}

export function intentsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
