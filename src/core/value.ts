// Physical PLAIN decoders and logical-type conversion.
// Values are returned as plain JS values where exact, and as small wrapper
// objects where a JS number cannot represent them (INT64, DECIMAL, INT96).

import { ByteReader } from './io.js';
import {
  ConvertedType,
  LogicalType,
  SchemaNode,
  Type,
} from './types.js';

/** Exact INT64 / uint64 marker. */
export class Int64Value {
  constructor(readonly value: bigint) {}
  toString(): string {
    return this.value.toString();
  }
}

/** Decimal with exact textual representation. */
export class DecimalValue {
  constructor(
    readonly unscaled: bigint,
    readonly scale: number,
  ) {}

  toString(): string {
    const neg = this.unscaled < 0n;
    const digits = (neg ? -this.unscaled : this.unscaled).toString();
    if (this.scale === 0) return (neg ? '-' : '') + digits;
    const sign = neg ? '-' : '';
    if (digits.length <= this.scale) {
      return `${sign}0.${'0'.repeat(this.scale - digits.length)}${digits}`;
    }
    const cut = digits.length - this.scale;
    return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
  }
}

/** INT96 timestamp (Impala convention). */
export class Int96Value {
  constructor(
    readonly julianDay: number,
    readonly nanosOfDay: bigint,
  ) {}

  /** Julian day at Unix epoch (1970-01-01). */
  static readonly JULIAN_EPOCH = 2440588;
  static readonly NANOS_PER_DAY = 86400000000000n;

  toIsoString(): string {
    // INT96 (Impala) timestamps carry no timezone; the value is a wall-clock
    // instant, so render with full nanosecond precision without a UTC claim.
    const daysSinceEpoch = this.julianDay - Int96Value.JULIAN_EPOCH;
    const msFromDays = daysSinceEpoch * 86400000;
    const totalMs = msFromDays + Number(this.nanosOfDay / 1000000n);
    const date = new Date(totalMs);
    const nanosWithinSecond = Number(this.nanosOfDay % 1000000000n);
    const pad = (n: number, w: number): string => String(n).padStart(w, '0');
    return (
      `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
      ` ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
      `.${pad(nanosWithinSecond, 9)} local-wall-clock`
    );
  }

  toString(): string {
    return this.toIsoString();
  }
}

export type DecodedValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Int64Value
  | DecimalValue
  | Int96Value
  | DecodedValue[]
  | { [key: string]: DecodedValue };

// ---- PLAIN physical decoders ----

export function decodePlainOne(reader: ByteReader, physical: Type, typeLength?: number): DecodedValue {
  switch (physical) {
    case Type.BOOLEAN:
      throw new Error('BOOLEAN PLAIN decoding is bit-wise, use decodePlainBooleans');
    case Type.INT32:
      return reader.i32();
    case Type.INT64:
      return new Int64Value(reader.i64());
    case Type.INT96: {
      const nanos = reader.u64();
      const dayBytes = reader.take(4);
      const julianDay =
        dayBytes[0] | (dayBytes[1] << 8) | (dayBytes[2] << 16) | (dayBytes[3] << 24);
      return new Int96Value(julianDay >>> 0, nanos);
    }
    case Type.FLOAT:
      return reader.float();
    case Type.DOUBLE:
      return reader.double();
    case Type.BYTE_ARRAY: {
      const len = reader.i32();
      return reader.take(len);
    }
    case Type.FIXED_LEN_BYTE_ARRAY: {
      return reader.take(typeLength ?? 0);
    }
    default:
      throw new Error(`unknown physical type ${physical}`);
  }
}

export function decodePlainValues(
  bytes: Uint8Array,
  physical: Type,
  count: number,
  typeLength?: number,
): DecodedValue[] {
  const reader = new ByteReader(bytes);
  if (physical === Type.BOOLEAN) {
    const out: boolean[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const byte = reader.data[reader.offset + (i >>> 3)];
      out[i] = ((byte >>> (i & 7)) & 1) === 1;
    }
    return out;
  }
  const out: DecodedValue[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = decodePlainOne(reader, physical, typeLength);
  }
  if (reader.remaining !== 0) {
    throw new Error(`PLAIN decode left ${reader.remaining} bytes (type ${Type[physical]})`);
  }
  return out;
}

// ---- Logical conversion ----

export interface LogicalContext {
  node: SchemaNode;
}

function isUnsigned(node: SchemaNode): boolean {
  if (node.logicalType?.type === 'INTEGER') return !node.logicalType.isSigned;
  switch (node.convertedType) {
    case ConvertedType.UINT_8:
    case ConvertedType.UINT_16:
    case ConvertedType.UINT_32:
    case ConvertedType.UINT_64:
      return true;
    default:
      return false;
  }
}

export function unsignedI32(v: number): number {
  return v >>> 0;
}

export function toLogical(raw: DecodedValue, node: SchemaNode): DecodedValue {
  if (raw === null) return null;

  const logical = node.logicalType;
  const converted = node.convertedType;

  // DECIMAL: INT32 / INT64 / FIXED_LEN_BYTE_ARRAY / BYTE_ARRAY.
  const decimalScale =
    logical?.type === 'DECIMAL'
      ? logical.scale
      : converted === ConvertedType.DECIMAL
        ? (node.scale ?? 0)
        : undefined;
  if (decimalScale !== undefined) {
    let unscaled: bigint;
    if (typeof raw === 'number') {
      unscaled = BigInt(raw);
    } else if (raw instanceof Int64Value) {
      unscaled = raw.value;
    } else if (raw instanceof Uint8Array) {
      unscaled = bigIntFromTwosComplement(raw);
    } else if (raw instanceof DecimalValue) {
      return raw;
    } else {
      throw new Error('DECIMAL on unsupported physical value');
    }
    return new DecimalValue(unscaled, decimalScale);
  }

  // Logical INTEGER / legacy unsigned converted types.
  if (logical?.type === 'INTEGER') {
    if (logical.bitWidth === 64 && raw instanceof Int64Value) {
      if (!logical.isSigned) return new Int64Value(raw.value & 0xffffffffffffffffn);
      return raw;
    }
    if (typeof raw === 'number') {
      return logical.isSigned ? raw : raw >>> 0;
    }
  }
  if (isUnsigned(node)) {
    if (typeof raw === 'number') return raw >>> 0;
    if (raw instanceof Int64Value) {
      return new Int64Value(raw.value & 0xffffffffffffffffn);
    }
  }

  // String-like byte arrays.
  if (
    logical?.type === 'STRING' ||
    logical?.type === 'ENUM' ||
    logical?.type === 'JSON' ||
    converted === ConvertedType.UTF8 ||
    converted === ConvertedType.ENUM ||
    converted === ConvertedType.JSON
  ) {
    if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
    return String(raw);
  }

  // DATE (INT32 days since epoch).
  if (logical?.type === 'DATE' || converted === ConvertedType.DATE) {
    if (typeof raw !== 'number') throw new Error('DATE requires INT32');
    return formatDate(raw);
  }

  // TIME.
  if (logical?.type === 'TIME') {
    return formatTime(raw, logical.unit.kind, node);
  }
  if (converted === ConvertedType.TIME_MILLIS) {
    return formatTime(raw, 'MILLIS', node);
  }
  if (converted === ConvertedType.TIME_MICROS) {
    return formatTime(raw, 'MICROS', node);
  }

  // TIMESTAMP.
  if (logical?.type === 'TIMESTAMP') {
    return formatTimestamp(raw, logical.unit.kind, logical.isAdjustedToUTC);
  }
  if (converted === ConvertedType.TIMESTAMP_MILLIS) {
    return formatTimestamp(raw, 'MILLIS', true);
  }
  if (converted === ConvertedType.TIMESTAMP_MICROS) {
    return formatTimestamp(raw, 'MICROS', true);
  }

  // INT96 (Impala timestamp).
  if (raw instanceof Int96Value) return raw.toIsoString();

  // UUID.
  if (logical?.type === 'UUID' && raw instanceof Uint8Array && raw.length === 16) {
    const hex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // FLOAT16 stored as 2 bytes; decode via DataView half precision.
  if (logical?.type === 'FLOAT16' && raw instanceof Uint8Array && raw.length === 2) {
    return decodeHalfFloat(raw);
  }

  return raw;
}

export function bigIntFromTwosComplement(bytes: Uint8Array): bigint {
  let positive = 0n;
  for (let i = 0; i < bytes.length; i++) {
    positive = (positive << 8n) | BigInt(bytes[i]);
  }
  const signBit = 1n << BigInt(bytes.length * 8 - 1);
  if ((positive & signBit) !== 0n) {
    return positive - (1n << BigInt(bytes.length * 8));
  }
  return positive;
}

function formatDate(daysSinceEpoch: number): string {
  const ms = daysSinceEpoch * 86400000;
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatTime(raw: DecodedValue, unit: string, node: SchemaNode): string {
  let total: bigint;
  if (raw instanceof Int64Value) total = raw.value;
  else if (typeof raw === 'number') total = BigInt(raw);
  else throw new Error('TIME requires INT32/INT64');
  const divisor =
    unit === 'MILLIS' ? 1000n : unit === 'MICROS' ? 1000000n : 1000000000n;
  void node;
  const h = total / 3600n / divisor;
  const m = (total / 60n / divisor) % 60n;
  const s = (total / divisor) % 60n;
  const frac = total % divisor;
  const pad = (n: bigint): string => n.toString().padStart(2, '0');
  let out = `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (frac !== 0n) {
    out += '.' + frac.toString().padStart(unit === 'MILLIS' ? 3 : unit === 'MICROS' ? 6 : 9, '0');
  }
  return out;
}

function formatTimestamp(raw: DecodedValue, unit: string, isUtc: boolean): string {
  let value: bigint;
  if (raw instanceof Int64Value) value = raw.value;
  else if (typeof raw === 'number') value = BigInt(raw);
  else throw new Error('TIMESTAMP requires INT64');
  const divisor =
    unit === 'MILLIS' ? 1000n : unit === 'MICROS' ? 1000000n : 1000000000n;
  const seconds = value / divisor;
  const frac = value < 0n && value % divisor !== 0n ? divisor + (value % divisor) : value % divisor;
  const ms = Number(seconds) * 1000 + Number(frac / (divisor / 1000n));
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const fracDigits =
    unit === 'MILLIS' ? 3 : unit === 'MICROS' ? 6 : 9;
  const fracText = frac === 0n
    ? '0'.repeat(fracDigits)
    : frac.toString().padStart(fracDigits, '0');
  return `${base}.${fracText} ${isUtc ? 'UTC' : 'local-wall-clock'}`;
}

function decodeHalfFloat(bytes: Uint8Array): number {
  const h = bytes[0] | (bytes[1] << 8);
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h & 0x7c00) >>> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 0x1f) return frac === 0 ? sign * Infinity : NaN;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/** Render any decoded value as stable text (used for diffs and JSON export). */
export function valueToText(v: DecodedValue): string {
  if (v === null) return 'null';
  if (v instanceof Uint8Array) {
    return '0x' + [...v].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (v instanceof Int64Value) return v.toString();
  if (v instanceof DecimalValue) return v.toString();
  if (v instanceof Int96Value) return v.toIsoString();
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Decode a min/max statistics payload into a logical value. */
export function decodeStatValue(bytes: Uint8Array, node: SchemaNode): DecodedValue {
  const physical = node.physicalType;
  if (physical === undefined) return bytes;
  // BOOLEAN stats are a single bit in the first payload byte.
  if (physical === Type.BOOLEAN) {
    return (bytes[0] & 0x01) === 1;
  }
  // BYTE_ARRAY min/max statistics carry the raw value bytes with NO 4-byte
  // length prefix (the prefix only appears inside PLAIN-encoded pages).
  if (physical === Type.BYTE_ARRAY) {
    return toLogical(bytes, node);
  }
  // FIXED_LEN_BYTE_ARRAY stats are exactly typeLength bytes, also no prefix.
  if (physical === Type.FIXED_LEN_BYTE_ARRAY) {
    return toLogical(bytes, node);
  }
  const reader = new ByteReader(bytes);
  const raw = decodePlainOne(reader, physical, node.typeLength);
  return toLogical(raw, node);
}
