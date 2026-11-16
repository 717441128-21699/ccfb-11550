// Random-access byte sources used by the parser.
// The same interfaces work in the browser (File with block cache) and in Node
// (a file descriptor with range reads), so parsing code never touches I/O directly.

import type * as fsType from 'node:fs';

/** A random-access, read-only source of bytes. */
export interface RandomAccessFile {
  /** File size in bytes. */
  readonly size: number;
  /** Read exactly `length` bytes starting at `position`. */
  readAt(position: number, length: number): Promise<Uint8Array>;
  /** Optional: read the whole file into memory (used for tiny test files). */
  readAll?(): Promise<Uint8Array>;
  /** Human-readable name for error messages. */
  readonly name: string;
}

/** In-memory implementation backed by one Uint8Array (tests, small files). */
export class MemoryFile implements RandomAccessFile {
  readonly size: number;

  constructor(
    private readonly bytes: Uint8Array,
    readonly name: string = 'memory',
  ) {
    this.size = bytes.length;
  }

  async readAt(position: number, length: number): Promise<Uint8Array> {
    if (position < 0 || position + length > this.bytes.length) {
      throw new Error(
        `read out of bounds: position=${position} length=${length} size=${this.bytes.length}`,
      );
    }
    return this.bytes.subarray(position, position + length);
  }

  async readAll(): Promise<Uint8Array> {
    return this.bytes;
  }
}

/** Node fs implementation using positional pread-style reads. */
export class NodeFile implements RandomAccessFile {
  readonly size: number;

  constructor(
    private readonly fd: number,
    readonly name: string,
    size: number,
    private readonly fs: typeof fsType,
  ) {
    this.size = size;
  }

  async readAt(position: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    let off = 0;
    while (off < length) {
      const n = this.fs.readSync(this.fd, buf, off, length - off, position + off);
      if (n === 0) throw new Error(`unexpected EOF at ${position + off}`);
      off += n;
    }
    return buf;
  }
}

interface CacheBlock {
  start: number;
  data: Uint8Array;
  lastUse: number;
}

/**
 * Block-caching wrapper around a RandomAccessFile. Reads are served from
 * fixed-size blocks held in an LRU cache so repeated footer/page reads never
 * hit disk (or the browser File API) twice. A 2 GB file only ever touches the
 * byte ranges the parser actually asks for.
 */
export class CachedFile implements RandomAccessFile {
  readonly size: number;
  readonly name: string;
  private blocks = new Map<number, CacheBlock>();
  private cachedBytes = 0;
  private clock = 0;

  constructor(
    private readonly inner: RandomAccessFile,
    private readonly blockSize = 4 * 1024 * 1024,
    private readonly maxCachedBytes = 256 * 1024 * 1024,
  ) {
    this.size = inner.size;
    this.name = inner.name;
  }

  private blockIndex(position: number): number {
    return Math.floor(position / this.blockSize);
  }

  private evictUntil(budget: number): void {
    while (this.cachedBytes > budget && this.blocks.size > 0) {
      let oldestKey = -1;
      let oldestTime = Infinity;
      for (const [key, block] of this.blocks) {
        if (block.lastUse < oldestTime) {
          oldestTime = block.lastUse;
          oldestKey = key;
        }
      }
      const victim = this.blocks.get(oldestKey)!;
      this.cachedBytes -= victim.data.length;
      this.blocks.delete(oldestKey);
    }
  }

  private async getBlock(index: number): Promise<CacheBlock> {
    const hit = this.blocks.get(index);
    if (hit) {
      hit.lastUse = ++this.clock;
      return hit;
    }
    const start = index * this.blockSize;
    const length = Math.min(this.blockSize, this.size - start);
    const data = await this.inner.readAt(start, length);
    const block: CacheBlock = { start, data, lastUse: ++this.clock };
    this.blocks.set(index, block);
    this.cachedBytes += data.length;
    if (this.cachedBytes > this.maxCachedBytes) {
      this.evictUntil(this.maxCachedBytes);
    }
    return block;
  }

  async readAt(position: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    if (position < 0 || position + length > this.size) {
      throw new Error(
        `read out of bounds: position=${position} length=${length} size=${this.size}`,
      );
    }
    const first = this.blockIndex(position);
    const last = this.blockIndex(position + length - 1);
    if (first === last) {
      const block = await this.getBlock(first);
      const offset = position - block.start;
      return block.data.subarray(offset, offset + length);
    }
    const out = new Uint8Array(length);
    let copied = 0;
    for (let i = first; i <= last; i++) {
      const block = await this.getBlock(i);
      const startInBlock = Math.max(0, position - block.start);
      const endInBlock = Math.min(block.data.length, position + length - block.start);
      out.set(block.data.subarray(startInBlock, endInBlock), copied);
      copied += endInBlock - startInBlock;
    }
    return out;
  }

  async readAll(): Promise<Uint8Array> {
    return this.inner.readAll ? this.inner.readAll() : this.readAt(0, this.size);
  }

  /** Cache diagnostics for the UI. */
  get cacheStats(): { blocks: number; cachedBytes: number } {
    return { blocks: this.blocks.size, cachedBytes: this.cachedBytes };
  }
}

/** Browser File/Blob implementation: reads go through blob.slice().arrayBuffer(). */
export class BlobFile implements RandomAccessFile {
  readonly size: number;
  readonly name: string;

  constructor(private readonly blob: Blob) {
    this.size = blob.size;
    this.name = (blob as { name?: string }).name || 'dropped-file.parquet';
  }

  async readAt(position: number, length: number): Promise<Uint8Array> {
    const slice = this.blob.slice(position, position + length);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }
}

/** Cursor over a contiguous byte buffer with all the little-endian primitives. */
export class ByteReader {
  offset = 0;

  constructor(readonly data: Uint8Array) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.view = view;
  }

  private readonly view: DataView;

  get remaining(): number {
    return this.data.length - this.offset;
  }

  require(n: number): void {
    if (this.offset + n > this.data.length) {
      throw new Error(
        `unexpected end of buffer: need ${n} bytes at offset ${this.offset}, have ${this.remaining}`,
      );
    }
  }

  u8(): number {
    this.require(1);
    return this.data[this.offset++];
  }

  i32(): number {
    this.require(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u32(): number {
    this.require(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i64(): bigint {
    this.require(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  u64(): bigint {
    this.require(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  float(): number {
    this.require(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  double(): number {
    this.require(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** Unsigned LEB128 varint (Thrift compact protocol, RLE headers). */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      if (shift >= 32) {
        // Guard against pathological encodings; Parquet varints fit in 5 bytes.
        throw new Error('varint too large');
      }
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  }

  /** Varint that may exceed 32 bits (returned as BigInt). */
  varintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too large');
    }
  }

  slice(n: number): Uint8Array {
    this.require(n);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** Copy out (detached from the underlying buffer). */
  take(n: number): Uint8Array {
    const s = this.slice(n);
    return s.slice();
  }
}

export function zigzagDecode(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

export function zigzagDecodeBig(n: bigint): bigint {
  return (n >> 1n) ^ -(n & 1n);
}
