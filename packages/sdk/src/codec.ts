import { getAddressDecoder, getAddressEncoder } from "@solana/kit";
import type { Address } from "@solana/kit";

import { idlTypeDef } from "./idl.js";
import type { IdlField, IdlType } from "./idl.js";

/**
 * Minimal Borsh codec driven by IDL type descriptors. It covers exactly the types the Forge
 * program uses; anything else throws so IDL drift fails loudly instead of mis-encoding.
 */
export type BorshValue =
  | boolean
  | number
  | bigint
  | Address
  | Uint8Array
  | BorshValue[]
  | string
  | { [key: string]: BorshValue };

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

const U64_MAX = 2n ** 64n - 1n;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function createWriter() {
  const chunks: Uint8Array[] = [];
  return {
    bytes(value: Uint8Array) {
      chunks.push(value);
    },

    finish(): Uint8Array {
      const length = chunks.reduce((sum, c) => sum + c.length, 0);
      const out = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },

    int(value: bigint, size: number, signed: boolean) {
      const buffer = new Uint8Array(size);
      const view = new DataView(buffer.buffer);
      if (size === 1) {
        view.setUint8(0, Number(value));
      } else if (size === 2) {
        view.setUint16(0, Number(value), true);
      } else if (size === 4) {
        view.setUint32(0, Number(value), true);
      } else if (signed) {
        view.setBigInt64(0, value, true);
      } else {
        view.setBigUint64(0, value, true);
      }
      chunks.push(buffer);
    },
  };
}

type Writer = ReturnType<typeof createWriter>;

class Reader {
  offset = 0;
  private readonly data: Uint8Array;
  private view: DataView;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  take(size: number): Uint8Array {
    if (this.offset + size > this.data.length) {
      throw new Error("Unexpected end of Borsh data");
    }
    const out = this.data.slice(this.offset, this.offset + size);
    this.offset += size;
    return out;
  }

  int(size: number, signed: boolean): bigint {
    const start = this.offset;
    this.take(size);
    if (size === 1) {
      return BigInt(this.view.getUint8(start));
    }
    if (size === 2) {
      return BigInt(this.view.getUint16(start, true));
    }
    if (size === 4) {
      return BigInt(this.view.getUint32(start, true));
    }
    return signed
      ? this.view.getBigInt64(start, true)
      : this.view.getBigUint64(start, true);
  }
}

function integerSpec(
  type: string
): { size: number; signed: boolean } | undefined {
  switch (type) {
    case "u8": {
      return { signed: false, size: 1 };
    }
    case "u16": {
      return { signed: false, size: 2 };
    }
    case "u32": {
      return { signed: false, size: 4 };
    }
    case "u64": {
      return { signed: false, size: 8 };
    }
    case "i64": {
      return { signed: true, size: 8 };
    }
    default: {
      return undefined;
    }
  }
}

function checkRange(value: bigint, type: string) {
  const ranges: Record<string, [bigint, bigint]> = {
    i64: [I64_MIN, I64_MAX],
    u16: [0n, 65_535n],
    u32: [0n, 4_294_967_295n],
    u64: [0n, U64_MAX],
    u8: [0n, 255n],
  };
  const range = ranges[type];
  if (!range || value < range[0] || value > range[1]) {
    throw new RangeError(`${value} is out of range for ${type}`);
  }
}

function encodeValue(
  writer: Writer,
  type: IdlType,
  value: BorshValue,
  path: string
) {
  if (typeof type === "string") {
    if (type === "bool") {
      if (typeof value !== "boolean") {
        throw new TypeError(`${path} must be a boolean`);
      }
      writer.int(value ? 1n : 0n, 1, false);
      return;
    }
    if (type === "pubkey") {
      writer.bytes(new Uint8Array(addressEncoder.encode(value as Address)));
      return;
    }
    const spec = integerSpec(type);
    if (!spec) {
      throw new Error(`Unsupported IDL type ${type} at ${path}`);
    }
    if (typeof value !== "bigint" && typeof value !== "number") {
      throw new TypeError(`${path} must be an integer`);
    }
    const asBigInt = BigInt(value);
    checkRange(asBigInt, type);
    writer.int(asBigInt, spec.size, spec.signed);
    return;
  }
  if ("array" in type) {
    const [inner, length] = type.array;
    if (inner === "u8") {
      if (!(value instanceof Uint8Array) || value.length !== length) {
        throw new TypeError(`${path} must be ${length} bytes`);
      }
      writer.bytes(value);
      return;
    }
    if (!Array.isArray(value) || value.length !== length) {
      throw new TypeError(`${path} must have ${length} elements`);
    }
    for (const [index, item] of value.entries()) {
      encodeValue(writer, inner, item, `${path}[${index}]`);
    }
    return;
  }
  const def = idlTypeDef(type.defined.name);
  if (def.type.kind === "enum") {
    const index = def.type.variants.findIndex((v) => v.name === value);
    if (index === -1) {
      throw new TypeError(`${path} is not a ${def.name} variant`);
    }
    writer.int(BigInt(index), 1, false);
    return;
  }
  // oxlint-disable-next-line no-use-before-define -- mutually recursive with encodeFields (nested structs)
  encodeFields(
    writer,
    def.type.fields,
    value as Record<string, BorshValue>,
    path
  );
}

function encodeFields(
  writer: Writer,
  fields: IdlField[],
  values: Record<string, BorshValue>,
  path: string
) {
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined) {
      throw new TypeError(`Missing ${path}.${field.name}`);
    }
    encodeValue(writer, field.type, value, `${path}.${field.name}`);
  }
}

function decodeValue(reader: Reader, type: IdlType): BorshValue {
  if (typeof type === "string") {
    if (type === "bool") {
      const byte = reader.int(1, false);
      if (byte > 1n) {
        throw new Error("Invalid Borsh bool");
      }
      return byte === 1n;
    }
    if (type === "pubkey") {
      return addressDecoder.decode(reader.take(32));
    }
    const spec = integerSpec(type);
    if (!spec) {
      throw new Error(`Unsupported IDL type ${type}`);
    }
    const value = reader.int(spec.size, spec.signed);
    return spec.size <= 2 ? Number(value) : value;
  }
  if ("array" in type) {
    const [inner, length] = type.array;
    if (inner === "u8") {
      return reader.take(length);
    }
    return Array.from({ length }, () => decodeValue(reader, inner));
  }
  const def = idlTypeDef(type.defined.name);
  if (def.type.kind === "enum") {
    const index = Number(reader.int(1, false));
    const variant = def.type.variants[index];
    if (!variant) {
      throw new Error(`Invalid ${def.name} variant ${index}`);
    }
    return variant.name;
  }
  // oxlint-disable-next-line no-use-before-define -- mutually recursive with decodeFields (nested structs)
  return decodeFields(reader, def.type.fields);
}

function decodeFields(
  reader: Reader,
  fields: IdlField[]
): Record<string, BorshValue> {
  const out: Record<string, BorshValue> = {};
  for (const field of fields) {
    out[field.name] = decodeValue(reader, field.type);
  }
  return out;
}

function startsWith(data: Uint8Array, prefix: number[]): boolean {
  return (
    prefix.length <= data.length && prefix.every((byte, i) => data[i] === byte)
  );
}

/** Encodes `discriminator ‖ fields`, rejecting missing, extra-range or mistyped values. */
export function encodeWithDiscriminator(
  discriminator: number[],
  fields: IdlField[],
  values: Record<string, BorshValue>
): Uint8Array {
  const writer = createWriter();
  writer.bytes(Uint8Array.from(discriminator));
  encodeFields(writer, fields, values, "args");
  return writer.finish();
}

/** Decodes `discriminator ‖ fields`; returns undefined when the discriminator differs. */
export function decodeWithDiscriminator(
  discriminator: number[],
  fields: IdlField[],
  data: Uint8Array,
  { exact }: { exact: boolean }
): Record<string, BorshValue> | undefined {
  if (!startsWith(data, discriminator)) {
    return undefined;
  }
  const reader = new Reader(data.subarray(discriminator.length));
  const values = decodeFields(reader, fields);
  if (exact && reader.offset !== data.length - discriminator.length) {
    throw new Error("Trailing bytes after Borsh data");
  }
  return values;
}
