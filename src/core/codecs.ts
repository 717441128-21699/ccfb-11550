// Compression codecs.
//  - UNCOMPRESSED: passthrough
//  - GZIP: Web Streams DecompressionStream (browser + Node), with Node zlib fallback
//  - SNAPPY: hand-written raw-block decompressor (Parquet uses the block format,
//    not the framed Java format)
//  - ZSTD: hand-written raw frame decoder in zstd.ts
// Other codecs produce explicit errors naming the column/page.

import { ByteReader } from './io.js';
import { CompressionCodec } from './types.js';
import { decompressZstd, ZstdUnsupportedError } from './zstd.js';

export interface DecompressContext {
  codec: CompressionCodec;
  /** For diagnostics, e.g. "row group 0, column 'id', data page 3". */
  pageLabel: string;
  uncompressedSize: number;
}

export class UnsupportedCompressionError extends Error {
  constructor(
    readonly codec: CompressionCodec,
    readonly pageLabel: string,
    detail?: string,
  ) {
    super(
      `${CompressionCodec[codec]} compression is not supported (${pageLabel})${
        detail ? `: ${detail}` : ''
      }`,
    );
    this.name = 'UnsupportedCompressionError';
  }
}

async function gunzip(input: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    // Copy into a fresh ArrayBuffer so the view's buffer is a plain ArrayBuffer
    // (Blob rejects SharedArrayBuffer-backed views under strict typings).
    const copy = new Uint8Array(input.length);
    copy.set(input);
    const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  // Node fallback (test runner on runtimes without DecompressionStream).
  if (typeof process !== 'undefined' && process.versions?.node) {
    const moduleName = 'node:zlib';
    const nodeZlib = await import(/* @vite-ignore */ moduleName).catch(() => null);
    if (nodeZlib) return nodeZlib.gunzipSync(input) as Uint8Array;
  }
  throw new Error('no gzip decompressor available in this runtime');
}

/**
 * Decode a Snappy raw block. Format:
 *   varint uncompressed length
 *   repeated tag:
 *     00  literal:        length 1 (tag>>2==0) / 2..60 inline / 61..64 extra bytes
 *     01  copy 1-byte:    length 4..11 in tag>>2, offset = ((tag&0xe0)<<3)|next
 *     10  copy 2-byte:    length 1..64 in tag>>2 (add 1), little-endian offset
 *     11  copy 4-byte:    length 1..64 in tag>>2 (add 1), little-endian offset
 */
export function decompressSnappy(input: Uint8Array, expectedSize: number): Uint8Array {
  const reader = new ByteReader(input);
  const declaredLength = reader.varintBig();
  if (declaredLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('snappy block claims >2^53 bytes');
  }
  const outLen = Number(declaredLength);
  if (expectedSize !== undefined && outLen !== expectedSize) {
    throw new Error(`snappy size mismatch: header says ${outLen}, page header says ${expectedSize}`);
  }
  const out = new Uint8Array(outLen);
  let outPos = 0;

  while (reader.remaining > 0) {
    const tag = reader.u8();
    const kind = tag & 0x03;
    if (kind === 0) {
      let literalLen: number;
      const sixBits = tag >> 2;
      if (sixBits < 60) {
        // Inline length: upper six bits hold len - 1.
        literalLen = sixBits + 1;
      } else {
        // Extended length: 1..4 bytes follow holding len - 1 little-endian;
        // sixBits 60..64 selects how many.
        const extraBytes = sixBits - 59; // 60 -> 1, ..., 64 -> 5... actually 60->1..63->4
        let stored = 0;
        for (let i = 0; i < extraBytes; i++) {
          stored |= reader.u8() << (8 * i);
        }
        literalLen = stored + 1;
      }
      const literal = reader.slice(literalLen);
      out.set(literal, outPos);
      outPos += literalLen;
    } else if (kind === 1) {
      // Copy with 1-byte offset: length 4..11 from bits 2..4; 11-bit offset
      // whose high 3 bits are tag bits 5..7 (shifted up to 8..10) and low 8
      // bits are the next byte.
      const len = 4 + ((tag >> 2) & 0x07);
      const offset = ((tag & 0xe0) << 3) | reader.u8();
      copyFromHistory(out, outPos, offset, len);
      outPos += len;
    } else if (kind === 2) {
      const len = 1 + (tag >> 2);
      const offset = reader.u8() | (reader.u8() << 8);
      copyFromHistory(out, outPos, offset, len);
      outPos += len;
    } else {
      const len = 1 + (tag >> 2);
      const offset = reader.u8() | (reader.u8() << 8) | (reader.u8() << 16) | (reader.u8() << 24);
      copyFromHistory(out, outPos, offset >>> 0, len);
      outPos += len;
    }
  }
  if (outPos !== outLen) {
    throw new Error(`snappy output short: wrote ${outPos} of ${outLen} bytes`);
  }
  return out;
}

function copyFromHistory(out: Uint8Array, pos: number, offset: number, len: number): void {
  if (offset === 0) throw new Error('snappy copy with zero offset');
  if (offset > pos) throw new Error(`snappy copy before start: offset=${offset} pos=${pos}`);
  // Byte-at-a-time: copies may overlap (len > offset is common for runs).
  for (let i = 0; i < len; i++) {
    out[pos + i] = out[pos - offset + i];
  }
}

export async function decompressPage(
  input: Uint8Array,
  ctx: DecompressContext,
): Promise<Uint8Array> {
  switch (ctx.codec) {
    case CompressionCodec.UNCOMPRESSED:
      return input;
    case CompressionCodec.GZIP: {
      const out = await gunzip(input, ctx.uncompressedSize);
      if (out.length !== ctx.uncompressedSize) {
        throw new Error(
          `gzip size mismatch on ${ctx.pageLabel}: got ${out.length}, expected ${ctx.uncompressedSize}`,
        );
      }
      return out;
    }
    case CompressionCodec.SNAPPY: {
      const out = decompressSnappy(input, ctx.uncompressedSize);
      if (out.length !== ctx.uncompressedSize) {
        throw new Error(
          `snappy size mismatch on ${ctx.pageLabel}: got ${out.length}, expected ${ctx.uncompressedSize}`,
        );
      }
      return out;
    }
    case CompressionCodec.ZSTD: {
      try {
        const out = decompressZstd(input, ctx.uncompressedSize);
        if (out.length !== ctx.uncompressedSize) {
          throw new Error(
            `zstd size mismatch on ${ctx.pageLabel}: got ${out.length}, expected ${ctx.uncompressedSize}`,
          );
        }
        return out;
      } catch (err) {
        if (err instanceof ZstdUnsupportedError) {
          throw new UnsupportedCompressionError(
            CompressionCodec.ZSTD,
            ctx.pageLabel,
            err.message,
          );
        }
        throw err;
      }
    }
    default:
      throw new UnsupportedCompressionError(ctx.codec, ctx.pageLabel);
  }
}
