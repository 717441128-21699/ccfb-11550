// Decoders for Parquet encodings:
//   RLE / bit-packing hybrid (definition & repetition levels, dictionary indices)
//   legacy BIT_PACKED (v1 boolean pages)
//   DELTA_BINARY_PACKED
//   DELTA_LENGTH_BYTE_ARRAY / DELTA_BYTE_ARRAY
// All bit-packing is the Parquet LSB-first variant.

import { ByteReader, zigzagDecode } from './io.js';

/**
 * Unpack `count` values of `bitWidth` bits from `data` starting at bit offset
 * `startBit` (LSB-first packing). Returns the new bit offset.
 */
export function unpackLittleEndian(
  data: Uint8Array,
  startBit: number,
  bitWidth: number,
  count: number,
  out: number[],
  outStart = 0,
): number {
  if (bitWidth === 0) {
    for (let i = 0; i < count; i++) out[outStart + i] = 0;
    return startBit;
  }
  const mask = bitWidth >= 32 ? 0xffffffff : (1 << bitWidth) - 1;
  let bitOffset = startBit;
  for (let i = 0; i < count; i++) {
    const byteIdx = bitOffset >>> 3;
    const shift = bitOffset & 7;
    let value: number;
    const bitsAvail = 8 - shift;
    if (bitsAvail >= bitWidth) {
      value = (data[byteIdx] >>> shift) & mask;
    } else {
      // Value straddles a byte boundary (at most 32-bit values => up to 5 bytes).
      value = data[byteIdx] >>> shift;
      const bitsFromNext = bitWidth - bitsAvail;
      let gathered = bitsAvail;
      let idx = byteIdx + 1;
      let nextShift = 0;
      while (gathered < bitWidth) {
        const take = Math.min(8, bitWidth - gathered);
        value |= (data[idx] & ((1 << take) - 1)) << gathered;
        gathered += take;
        nextShift += take;
        idx++;
      }
      value &= mask;
      void nextShift;
    }
    out[outStart + i] = value;
    bitOffset += bitWidth;
  }
  return bitOffset;
}

/**
 * Decode the RLE/bit-packing hybrid run stream.
 * `expectedCount` is the number of values the stream must yield (numValues for
 * levels; dictionary page count for indices).
 */
export function decodeRleBitPackedHybrid(
  data: Uint8Array,
  bitWidth: number,
  expectedCount: number,
): number[] {
  if (bitWidth === 0) {
    // No bits needed: every value is implicitly 0. An RLE run may still carry
    // the count explicitly (even header = count << 1).
    const reader = new ByteReader(data);
    if (reader.remaining >= 1) {
      const header = reader.varint();
      if ((header & 1) === 0) {
        return new Array(header >>> 1).fill(0);
      }
    }
    return new Array(expectedCount).fill(0);
  }

  const reader = new ByteReader(data);
  const out: number[] = [];
  while (out.length < expectedCount && reader.remaining > 0) {
    const header = reader.varint();
    if ((header & 1) === 1) {
      // Bit-packed run (parquet Encodings.md): odd header = 2 * num_groups + 1,
      // each group holding exactly 8 LSB-first-packed values.
      const numGroups = header >>> 1;
      const count = numGroups * 8;
      const startBit = reader.offset * 8;
      unpackLittleEndian(data, startBit, bitWidth, count, out, out.length);
      reader.offset += Math.ceil((count * bitWidth) / 8);
    } else {
      // RLE run: even header = repeat_count << 1.
      const count = header >>> 1;
      const byteWidth = Math.max(1, Math.ceil(bitWidth / 8));
      let value = 0;
      for (let b = 0; b < byteWidth; b++) {
        value |= reader.u8() << (8 * b);
      }
      const mask = bitWidth >= 32 ? 0xffffffff : (1 << bitWidth) - 1;
      value &= mask;
      for (let i = 0; i < count; i++) out.push(value);
    }
  }
  if (out.length < expectedCount) {
    throw new Error(
      `RLE/bit-packed stream ended early: produced ${out.length} of ${expectedCount} values (bitWidth=${bitWidth})`,
    );
  }
  if (out.length > expectedCount) {
    out.length = expectedCount;
  }
  return out;
}

/**
 * Decode a stream that starts with the 4-byte hybrid length prefix
 * (definition/repetition levels and dictionary indices in data pages).
 */
export function decodeHybridWithLengthPrefix(
  data: Uint8Array,
  bitWidth: number,
  expectedCount: number,
): number[] {
  const reader = new ByteReader(data);
  const length = reader.u32();
  if (reader.offset + length > data.length) {
    throw new Error(`hybrid stream length ${length} exceeds buffer (${data.length - reader.offset} bytes left)`);
  }
  const body = data.subarray(reader.offset, reader.offset + length);
  return decodeRleBitPackedHybrid(body, bitWidth, expectedCount);
}

/**
 * Legacy BIT_PACKED encoding (v1 data pages only, e.g. booleans). Values are
 * packed in groups of 8 with no hybrid framing, final group padded.
 */
export function decodeLegacyBitPacked(
  data: Uint8Array,
  bitWidth: number,
  expectedCount: number,
): number[] {
  const out: number[] = new Array(expectedCount).fill(0);
  unpackLittleEndian(data, 0, bitWidth, expectedCount, out, 0);
  return out;
}

/**
 * DELTA_BINARY_PACKED: blocks of min-delta + bit-packed deltas.
 * Returns signed 32-bit integers (also used for lengths and 64-bit blocks via
 * BigInt variant below).
 */
export function decodeDeltaBinaryPacked32(data: Uint8Array): number[] {
  const reader = new ByteReader(data);
  const blockSize = reader.varint();
  const numMiniBlocks = reader.varint();
  const totalCount = reader.varint();
  if (totalCount === 0) return [];
  const firstValue = zigzagDecode(reader.varint());

  const out = new Array<number>(totalCount);
  out[0] = firstValue;
  let valuesWritten = 1;
  const miniBlockSize = blockSize / numMiniBlocks;
  if (!Number.isInteger(miniBlockSize) || miniBlockSize % 8 !== 0) {
    throw new Error(
      `invalid delta block geometry: blockSize=${blockSize} miniBlocks=${numMiniBlocks}`,
    );
  }

  while (valuesWritten < totalCount) {
    const minDelta = zigzagDecode(reader.varint());
    const bitWidths = new Array<number>(numMiniBlocks);
    for (let i = 0; i < numMiniBlocks; i++) bitWidths[i] = reader.u8();

    const valuesLeftInBlock = Math.min(blockSize, totalCount - valuesWritten);
    for (let mb = 0; mb < numMiniBlocks; mb++) {
      const bw = bitWidths[mb];
      const take = Math.min(miniBlockSize, valuesLeftInBlock - mb * miniBlockSize);
      const startBit = reader.offset * 8;
      // Always unpack/consume the full padded mini-block slot on the wire.
      const tmp: number[] = [];
      unpackLittleEndian(data, startBit, bw, miniBlockSize, tmp, 0);
      reader.offset += Math.ceil((miniBlockSize * bw) / 8);
      if (take <= 0) {
        // Padding mini-block: bytes consumed above, no values emitted.
        continue;
      }
      for (let i = 0; i < take; i++) {
        const next = out[valuesWritten - 1] + tmp[i] + minDelta;
        out[valuesWritten] = next;
        valuesWritten++;
      }
    }
  }
  if (valuesWritten !== totalCount) {
    throw new Error(`delta decoding produced ${valuesWritten} of ${totalCount} values`);
  }
  return out;
}

/** Like decodeDeltaBinaryPacked32 but also reports how many input bytes were used. */
export function decodeDeltaBinaryPacked32WithOffset(data: Uint8Array): {
  values: number[];
  bytesConsumed: number;
} {
  const values = decodeDeltaBinaryPacked32(data);
  // Re-walk the framing using the exact same reader accounting to measure length.
  const r = new ByteReader(data);
  const blockSize = r.varint();
  const numMiniBlocks = r.varint();
  const totalCount = r.varint();
  if (totalCount === 0) return { values, bytesConsumed: r.offset };
  r.varint(); // first value
  const miniBlockSize = blockSize / numMiniBlocks;
  let written = 1;
  while (written < totalCount) {
    r.varint(); // min delta
    const widths: number[] = [];
    for (let i = 0; i < numMiniBlocks; i++) widths.push(r.u8());
    const valuesLeft = Math.min(blockSize, totalCount - written);
    for (let mb = 0; mb < numMiniBlocks; mb++) {
      // Every mini-block occupies a fixed padded byte size on the wire.
      r.offset += Math.ceil((miniBlockSize * widths[mb]) / 8);
    }
    written += valuesLeft;
  }
  return { values, bytesConsumed: r.offset };
}

/** 64-bit variant: deltas are unpacked per mini-block then accumulated in BigInt. */
export function decodeDeltaBinaryPacked64(data: Uint8Array): bigint[] {
  const reader = new ByteReader(data);
  const blockSize = reader.varint();
  const numMiniBlocks = reader.varint();
  const totalCount = reader.varint();
  if (totalCount === 0) return [];
  // First value is a zigzag i64 varint.
  let firstValue = 0n;
  {
    let shift = 0n;
    for (;;) {
      const b = reader.u8();
      firstValue |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    firstValue = (firstValue >> 1n) ^ -(firstValue & 1n);
  }

  const out = new Array<bigint>(totalCount);
  out[0] = firstValue;
  let valuesWritten = 1;
  const miniBlockSize = blockSize / numMiniBlocks;

  while (valuesWritten < totalCount) {
    const minDelta = BigInt(zigzagDecode(reader.varint()));
    const bitWidths = new Array<number>(numMiniBlocks);
    for (let i = 0; i < numMiniBlocks; i++) bitWidths[i] = reader.u8();

    const valuesLeftInBlock = Math.min(blockSize, totalCount - valuesWritten);
    for (let mb = 0; mb < numMiniBlocks; mb++) {
      const bw = bitWidths[mb];
      const take = Math.min(miniBlockSize, valuesLeftInBlock - mb * miniBlockSize);
      if (take <= 0) continue;
      const startBit = reader.offset * 8;
      const tmp: number[] = [];
      unpackLittleEndian(data, startBit, bw, miniBlockSize, tmp, 0);
      reader.offset += Math.ceil((miniBlockSize * bw) / 8);
      for (let i = 0; i < take; i++) {
        out[valuesWritten] = out[valuesWritten - 1] + BigInt(tmp[i]) + minDelta;
        valuesWritten++;
      }
    }
  }
  if (valuesWritten !== totalCount) {
    throw new Error(`delta64 decoding produced ${valuesWritten} of ${totalCount} values`);
  }
  return out;
}

/** DELTA_LENGTH_BYTE_ARRAY: delta-encoded lengths followed by the raw bytes. */
export function decodeDeltaLengthByteArray(data: Uint8Array): Uint8Array[] {
  const { values: lengths, bytesConsumed } = decodeDeltaBinaryPacked32WithOffset(data);
  const reader = new ByteReader(data.subarray(bytesConsumed));
  const out: Uint8Array[] = [];
  for (const len of lengths) {
    out.push(reader.take(len));
  }
  return out;
}

/** Walk one DELTA_BINARY_PACKED stream and return its byte length. */
function measureDeltaLengthBytes(data: Uint8Array, start: number): number {
  const r = new ByteReader(data.subarray(start));
  const blockSize = r.varint();
  const numMiniBlocks = r.varint();
  const totalCount = r.varint();
  if (totalCount === 0) return r.offset;
  r.varint(); // first value
  const miniBlockSize = blockSize / numMiniBlocks;
  let remaining = totalCount - 1;
  while (remaining > 0) {
    r.varint(); // min delta
    const widths: number[] = [];
    for (let i = 0; i < numMiniBlocks; i++) widths.push(r.u8());
    const inBlock = Math.min(blockSize, remaining);
    const fullMiniBlocks = Math.floor(inBlock / miniBlockSize);
    for (let mb = 0; mb < numMiniBlocks; mb++) {
      const used = mb < fullMiniBlocks ? miniBlockSize : 0;
      void used;
      r.offset += Math.ceil((miniBlockSize * widths[mb]) / 8);
    }
    remaining -= inBlock;
  }
  return r.offset;
}

/** DELTA_BYTE_ARRAY: delta-encoded prefix lengths, suffix lengths, then suffixes. */
export function decodeDeltaByteArray(data: Uint8Array): Uint8Array[] {
  const prefix = decodeDeltaBinaryPacked32WithOffset(data);
  const prefixLengths = prefix.values;
  const suffixStart = prefix.bytesConsumed;
  const suffix = decodeDeltaBinaryPacked32WithOffset(data.subarray(suffixStart));
  const suffixLengths = suffix.values;
  const reader = new ByteReader(data.subarray(suffixStart + suffix.bytesConsumed));
  const count = prefixLengths.length;
  const out: Uint8Array[] = new Array(count);
  let previous = new Uint8Array(0);
  for (let i = 0; i < count; i++) {
    const prefixLen = prefixLengths[i];
    const suffixBytes = reader.take(suffixLengths[i]);
    const value = new Uint8Array(prefixLen + suffixBytes.length);
    value.set(previous.subarray(0, prefixLen), 0);
    value.set(suffixBytes, prefixLen);
    out[i] = value;
    previous = value;
  }
  return out;
}
