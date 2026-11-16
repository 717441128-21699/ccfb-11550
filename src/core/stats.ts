// Cross-check column chunk statistics against values actually decoded from
// the pages. Mismatches are reported with enough detail for the UI to flag.

import { ByteReader } from './io.js';
import type { ColumnReadResult } from './column.js';
import {
  ConvertedType,
  Statistics,
  Type,
} from './types.js';
import {
  DecodedValue,
  Int64Value,
  Int96Value,
  bigIntFromTwosComplement,
  decodePlainOne,
  decodeStatValue,
  toLogical,
  valueToText,
} from './value.js';
import type { SchemaNode } from './types.js';

export interface StatCheck {
  ok: boolean;
  nullCount: {
    expected: bigint | undefined;
    actual: number;
    ok: boolean;
  };
  min: {
    expected: DecodedValue | undefined;
    actual: DecodedValue | undefined;
    ok: boolean;
    note?: string;
  };
  max: {
    expected: DecodedValue | undefined;
    actual: DecodedValue | undefined;
    ok: boolean;
    note?: string;
  };
  issues: string[];
}

function isUnsignedNode(node: SchemaNode): boolean {
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

function physicalCompare(a: DecodedValue, b: DecodedValue, node: SchemaNode): number {
  const type = node.physicalType!;
  const unsigned = isUnsignedNode(node);
  switch (type) {
    case Type.BOOLEAN:
      return Number(a) - Number(b);
    case Type.INT32:
    case Type.FLOAT:
      // Unsigned 32-bit values must order as unsigned.
      if (unsigned) return ((a as number) >>> 0) - ((b as number) >>> 0);
      return (a as number) - (b as number);
    case Type.INT64: {
      const mask = 0xffffffffffffffffn;
      const av = unsigned ? ((a as Int64Value).value & mask) : (a as Int64Value).value;
      const bv = unsigned ? ((b as Int64Value).value & mask) : (b as Int64Value).value;
      return av < bv ? -1 : av > bv ? 1 : 0;
    }
    case Type.INT96: {
      const ai = a as Int96Value;
      const bi = b as Int96Value;
      if (ai.julianDay !== bi.julianDay) return ai.julianDay - bi.julianDay;
      return ai.nanosOfDay < bi.nanosOfDay ? -1 : ai.nanosOfDay > bi.nanosOfDay ? 1 : 0;
    }
    case Type.DOUBLE:
      return (a as number) - (b as number);
    case Type.BYTE_ARRAY:
    case Type.FIXED_LEN_BYTE_ARRAY:
      // DECIMAL compares by its signed two's-complement integer value, not
      // lexicographic byte order.
      if (node.logicalType?.type === 'DECIMAL' || node.convertedType === ConvertedType.DECIMAL) {
        const av = bigIntFromTwosComplement(a as Uint8Array);
        const bv = bigIntFromTwosComplement(b as Uint8Array);
        return av < bv ? -1 : av > bv ? 1 : 0;
      }
      return compareBytes(a as Uint8Array, b as Uint8Array);
    default:
      return 0;
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  // Default statistics ordering for byte arrays is unsigned lexicographic.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function physicalMinMax(
  physicalValues: DecodedValue[],
  node: SchemaNode,
): { min: DecodedValue | undefined; max: DecodedValue | undefined } {
  let min: DecodedValue | undefined;
  let max: DecodedValue | undefined;
  for (const v of physicalValues) {
    if (v === null) continue;
    if (min === undefined || physicalCompare(v, min, node) < 0) min = v;
    if (max === undefined || physicalCompare(v, max, node) > 0) max = v;
  }
  return { min, max };
}

function equalPhysical(a: DecodedValue | undefined, b: DecodedValue | undefined, node: SchemaNode): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return physicalCompare(a, b, node) === 0;
}

export function checkStatistics(result: ColumnReadResult): StatCheck {
  const stats: Statistics | undefined = result.chunk.metaData?.statistics;
  const node = result.node;
  const issues: string[] = [];
  const { min: actualMin, max: actualMax } = physicalMinMax(result.physicalValues, node);
  const actualNulls = result.physicalValues.filter((v) => v === null).length;

  const nullExpected = stats?.nullCount;
  const nullOk =
    nullExpected === undefined ? true : Number(nullExpected) === actualNulls;
  if (!nullOk) {
    issues.push(
      `null_count 统计=${nullExpected!.toString()} 实际=${actualNulls}`,
    );
  }

  // Prefer the order-correct minValue/maxValue fields; fall back to legacy
  // min/max (which use unsigned byte order even for signed types).
  const minBytes = stats?.minValue ?? stats?.min;
  const maxBytes = stats?.maxValue ?? stats?.max;
  const legacy = stats?.minValue === undefined && stats?.min !== undefined;

  let expectedMin: DecodedValue | undefined;
  let expectedMax: DecodedValue | undefined;
  let minOk = true;
  let maxOk = true;
  let minNote: string | undefined;
  let maxNote: string | undefined;

  if (minBytes !== undefined && node.physicalType !== undefined) {
    try {
      expectedMin = decodeStatValue(minBytes, node);
    } catch (err) {
      minOk = false;
      minNote = `统计值解码失败: ${err instanceof Error ? err.message : String(err)}`;
      issues.push(minNote);
    }
  }
  if (maxBytes !== undefined && node.physicalType !== undefined) {
    try {
      expectedMax = decodeStatValue(maxBytes, node);
    } catch (err) {
      maxOk = false;
      maxNote = `统计值解码失败: ${err instanceof Error ? err.message : String(err)}`;
      issues.push(maxNote);
    }
  }

  if (expectedMin !== undefined && actualMin !== undefined) {
    minOk = equalPhysical(
      statBytesToPhysical(minBytes!, node),
      actualMin,
      node,
    );
    if (!minOk) {
      const note =
        legacy ? '（使用 legacy min，字节序可能与有符号类型不同）' : undefined;
      minNote = note;
      issues.push(
        `min 统计=${valueToText(toLogical(statBytesToPhysical(minBytes!, node), node))} ` +
          `实际=${valueToText(toLogical(actualMin, node))}${note ? ' ' + note : ''}`,
      );
    }
  }
  if (expectedMax !== undefined && actualMax !== undefined) {
    maxOk = equalPhysical(
      statBytesToPhysical(maxBytes!, node),
      actualMax,
      node,
    );
    if (!maxOk) {
      const note = legacy ? '（使用 legacy max）' : undefined;
      maxNote = note;
      issues.push(
        `max 统计=${valueToText(toLogical(statBytesToPhysical(maxBytes!, node), node))} ` +
          `实际=${valueToText(toLogical(actualMax, node))}${note ? ' ' + note : ''}`,
      );
    }
  }

  return {
    ok: nullOk && minOk && maxOk,
    nullCount: { expected: nullExpected, actual: actualNulls, ok: nullOk },
    min: {
      // expectedMin/Max already passed through decodeStatValue (logical form).
      expected: expectedMin,
      actual: actualMin === undefined ? undefined : toLogical(actualMin, node),
      ok: minOk,
      note: minNote,
    },
    max: {
      expected: expectedMax,
      actual: actualMax === undefined ? undefined : toLogical(actualMax, node),
      ok: maxOk,
      note: maxNote,
    },
    issues,
  };
}

/** Decode a statistics payload into a *physical* value for exact comparison. */
function statBytesToPhysical(bytes: Uint8Array, node: SchemaNode): DecodedValue {
  if (node.physicalType === Type.BOOLEAN) {
    return (bytes[0] & 0x01) === 1;
  }
  // Byte-array / fixed-len stats are raw value bytes with no length prefix.
  if (
    node.physicalType === Type.BYTE_ARRAY ||
    node.physicalType === Type.FIXED_LEN_BYTE_ARRAY
  ) {
    return bytes;
  }
  const reader = new ByteReader(bytes);
  return decodePlainOne(reader, node.physicalType!, node.typeLength);
}
