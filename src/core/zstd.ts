// Hand-written Zstandard raw-frame decompressor (RFC 8878), sufficient for the
// single-frame content Parquet writes. Implements FSE tables, Huffman-coded
// literals and match-copy sequences. Pure TypeScript, no native dependency.

import { ByteReader } from './io.js';

export class ZstdUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZstdUnsupportedError';
  }
}

const ZSTD_MAGIC = 0x28b52ffd;
const BLOCK_RAW = 0;
const BLOCK_RLE = 1;
const BLOCK_COMPRESSED = 2;

const MAX_BLOCK_SIZE = 128 * 1024;
const MAX_WINDOW_SIZE = 1 << 30;

const LL_DEFAULT_LOG = 9;
const ML_DEFAULT_LOG = 12;
const OF_DEFAULT_LOG = 8;

// Predefined FSE normalized distributions (RFC 8878 §4.8.2).
const LL_DEFAULT_DIST = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1,
  1, 1, 1, -1, -1, -1, -1,
];
const ML_DEFAULT_DIST = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1,
];
const OF_DEFAULT_DIST = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

interface FseTable {
  log: number;
  symbols: Uint16Array;
  numberOfBits: Uint8Array;
  newState: Uint32Array;
  size: number;
}

class BitReaderBE {
  offset = 0;
  private bitPos = 0; // 0..7, MSB-first within the current byte

  constructor(readonly data: Uint8Array) {}

  bit(): number {
    const b = (this.data[this.offset] >>> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.offset++;
    }
    return b;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  align(): void {
    if (this.bitPos !== 0) {
      this.bitPos = 0;
      this.offset++;
    }
  }
}

class BitReaderLE {
  pos = 0;
  private bitPos = 0;

  constructor(readonly data: Uint8Array, start = 0) {
    this.pos = start;
  }

  bits(n: number): number {
    let v = 0;
    let got = 0;
    while (got < n) {
      if (this.pos >= this.data.length) throw new Error('zstd: bitstream overrun');
      const room = 8 - this.bitPos;
      const take = Math.min(room, n - got);
      v |= ((this.data[this.pos] >>> this.bitPos) & ((1 << take) - 1)) << got;
      got += take;
      this.bitPos += take;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.pos++;
      }
    }
    return v >>> 0;
  }

  align(): void {
    if (this.bitPos !== 0) {
      this.bitPos = 0;
      this.pos++;
    }
  }
}

// ---- FSE normalized distribution (RFC §4.2.1.2) ----

function decodeDistribution(data: Uint8Array, start: number, maxLog: number): {
  log: number;
  weights: Int16Array;
  bytesConsumed: number;
} {
  const tableLog = data[start];
  if (tableLog > maxLog) throw new ZstdUnsupportedError(`FSE tableLog ${tableLog} > max ${maxLog}`);
  const br = new ByteReader(data);
  br.offset = start + 1;
  const range = br.varint() + 1;
  const weights = new Int16Array(range);
  const be = new BitReaderBE(data);
  be.offset = br.offset;
  let i = 0;
  while (i < range) {
    const header = data[be.offset];
    const high = header >> 4;
    const nibble = header & 0x0f;
    be.offset++;
    if (nibble === 0) {
      const count = high + 1;
      if (i + count > range) throw new Error('zstd: FSE distribution overrun');
      i += count; // zeros
    } else {
      if (i >= range) throw new Error('zstd: FSE distribution overrun');
      const baseline = 1 - (1 << nibble);
      weights[i++] = baseline + be.bits(nibble);
    }
  }
  be.align();
  let total = 0;
  for (const w of weights) total += w;
  if (1 << tableLog !== total) {
    throw new Error(`zstd: FSE weights sum ${total} != 2^${tableLog}`);
  }
  return { log: tableLog, weights, bytesConsumed: be.offset - start };
}

// ---- FSE decoding table (RFC §4.2.1) ----

function buildFseTable(weights: Int16Array, tableLog: number): FseTable {
  const size = 1 << tableLog;
  const symbols = new Uint16Array(size);
  const numberOfBits = new Uint8Array(size);
  const newState = new Uint32Array(size);

  const thresholds = new Int32Array(tableLog + 1).fill(0);
  for (const w of weights) if (w > 0) thresholds[w]++;
  let total = 0;
  for (let l = tableLog; l > 0; l--) {
    total += thresholds[l] << 1;
    thresholds[l] = total;
  }
  const positions = new Uint16Array(size);
  let highThreshold = size - total;
  const symbolNext = new Int32Array(tableLog + 2);
  symbolNext[1] = highThreshold;
  for (let l = 2; l <= tableLog; l++) symbolNext[l] = thresholds[l - 1];

  for (let s = 0; s < weights.length; s++) {
    const w = weights[s];
    if (w === 0) continue;
    if (w === -1) positions[highThreshold++] = s;
    else positions[symbolNext[w]++] = s;
  }

  const positionMask = size - 1;
  let state = 0;
  const step = (size >>> 1) + (size >>> 3) + 3;
  for (let i = 0; i < size; i++) {
    const symbol = positions[i];
    symbols[state] = symbol;
    const w = weights[symbol];
    numberOfBits[state] = tableLog - (w > 0 ? Math.round(Math.log2(w)) : 0);
    state = (state + step) & positionMask;
  }

  const baseline = new Int32Array(weights.length);
  for (let s = 0; s < weights.length; s++) baseline[s] = weights[s] < 0 ? 0 : weights[s];
  let left = 0;
  for (let s2 = 0; s2 < weights.length; s2++) {
    if (baseline[s2] === 0) continue;
    const sym = symbols[left];
    baseline[sym]--;
    newState[left] = baseline[sym];
    left++;
  }
  const allocated = new Int32Array(weights.length);
  for (let s = 0; s < weights.length; s++) allocated[s] = weights[s] < 0 ? 1 : weights[s];
  for (let st = left; st < size; st++) {
    const sym = symbols[st];
    newState[st] = allocated[sym]++;
  }
  return { log: tableLog, symbols, numberOfBits, newState, size };
}

function buildPredefined(weights: number[], log: number): FseTable {
  return buildFseTable(Int16Array.from(weights), log);
}

// ---- Huffman tables (RFC §4.2.1.1) ----

interface HuffmanTable {
  log: number;
  symbols: Uint16Array;
  numberOfBits: Uint8Array;
}

function decodeHuffmanWeights(data: Uint8Array, start: number): {
  weights: Uint8Array;
  bytesConsumed: number;
  flags: number;
} {
  const first = data[start];
  let count: number;
  let offset = 1;
  let flags = 0;
  if ((first & 0x80) !== 0) {
    count = ((first & 0x7f) << 8) + data[start + 1];
    offset = 2;
    flags = first >>> 6;
  } else {
    count = first;
  }
  const weights = new Uint8Array(count);
  let i = 0;
  while (i < count) {
    const byte = data[start + offset++];
    const upper = byte >> 4;
    const lower = byte & 0x0f;
    if (upper === 0) {
      const repeats = lower + 1;
      for (let k = 0; k < repeats && i < count; k++) weights[i++] = 0;
    } else if (lower === 0) {
      const repeats = upper;
      const value = weights[i - 1];
      for (let k = 0; k < repeats && i < count; k++) weights[i++] = value;
    } else {
      weights[i++] = upper;
      if (i < count) weights[i++] = lower;
    }
  }
  return { weights, bytesConsumed: offset, flags };
}

function buildHuffmanTable(weights: Uint8Array): HuffmanTable {
  let tableLog = 0;
  for (const w of weights) if (w > tableLog) tableLog = w;
  if (tableLog === 0 || tableLog > 11) throw new Error('zstd: bad huffman weights');
  const size = 1 << tableLog;
  const symbols = new Uint16Array(size);
  const numberOfBits = new Uint8Array(size);

  const present: number[] = [];
  for (let s = 0; s < weights.length; s++) if (weights[s] > 0) present.push(s);

  const left = new Int32Array(tableLog + 2);
  left[tableLog] = size;
  for (let l = tableLog; l > 0; l--) {
    let countAtWeight = 0;
    for (const w of weights) if (w === l) countAtWeight++;
    left[l - 1] = (left[l] - countAtWeight) >>> 1;
  }
  const codeLength = new Uint8Array(weights.length);
  for (const s of present) codeLength[s] = tableLog + 1 - weights[s];

  let node = 0;
  for (const s of present) {
    const len = codeLength[s];
    const fill = 1 << (tableLog - len);
    for (let k = 0; k < fill; k++) {
      if (node >= size) throw new Error('zstd: huffman table overrun');
      symbols[node] = s;
      numberOfBits[node] = len;
      node++;
    }
  }
  if (node !== size) throw new Error(`zstd: huffman table underfilled (${node}/${size})`);
  return { log: tableLog, symbols, numberOfBits };
}

// ---- Literal sections (RFC §4.2.2) ----

interface LiteralResult {
  literals: Uint8Array;
  sectionLength: number;
}

function readSize(block: Uint8Array, pos: number, sizeType: number, tagHigh: number): {
  size: number;
  pos: number;
} {
  if (sizeType === 0) return { size: tagHigh, pos };
  if (sizeType === 1) return { size: (tagHigh << 8) + block[pos], pos: pos + 1 };
  if (sizeType === 2) {
    return {
      size: (tagHigh << 16) + (block[pos] << 8) + block[pos + 1],
      pos: pos + 2,
    };
  }
  return {
    size:
      (block[pos] << 24) + (block[pos + 1] << 16) + (block[pos + 2] << 8) + block[pos + 3],
    pos: pos + 4,
  };
}

function decodeLiterals(block: Uint8Array, blockStart: number): LiteralResult {
  let pos = blockStart;
  const tag = block[pos++];
  const kind = tag & 0x03;
  const sizeType = (tag >>> 2) & 0x03;
  const tagHigh = tag >>> 4;

  if (kind === 0 || kind === 1) {
    const { size, pos: p } = readSize(block, pos, sizeType, tagHigh);
    pos = p;
    const literals = block.subarray(pos, pos + size).slice();
    return { literals, sectionLength: pos + size - blockStart };
  }
  if (kind === 2) {
    const { size, pos: p } = readSize(block, pos, sizeType, tagHigh);
    pos = p;
    const byte = block[pos++];
    return {
      literals: new Uint8Array(size).fill(byte),
      sectionLength: pos - blockStart,
    };
  }

  // kind === 3: Huffman-compressed literals.
  const lit = readSize(block, pos, sizeType, tagHigh);
  pos = lit.pos;
  const huf = readSize(block, pos, sizeType, tagHigh);
  pos = huf.pos;

  const hufStart = pos;
  const header = decodeHuffmanWeights(block, hufStart);
  const table = buildHuffmanTable(header.weights);
  const streamStart = hufStart + header.bytesConsumed;
  const compressedEnd = hufStart + huf.size;
  const compressedSize = compressedEnd - streamStart;

  const literals = new Uint8Array(lit.size);
  const streams = block.subarray(streamStart, compressedEnd);
  if (compressedSize === 0) {
    if (lit.size !== 0) throw new Error('zstd: empty huffman stream with literals');
  } else {
    const jumpLog = 5 + (header.flags & 0x03);
    const streamUnit = 1 << jumpLog;
    // Number of 4-byte units per stream; streams are 4-byte aligned.
    const numStreams = Math.max(1, Math.floor(compressedSize / streamUnit));
    const segmentSize = Math.ceil(lit.size / numStreams);
    let produced = 0;
    for (let s = 0; s < numStreams && produced < lit.size; s++) {
      const start = s * streamUnit;
      const end = s === numStreams - 1 ? compressedSize : start + streamUnit;
      const target = Math.min(segmentSize, lit.size - produced);
      const br = new BitReaderLE(streams, start);
      decodeHuffmanStream(br, table, literals, produced, target, end);
      produced += target;
    }
    if (produced !== lit.size) throw new Error('zstd: huffman literal count mismatch');
  }
  return { literals, sectionLength: compressedEnd - blockStart };
}

function decodeHuffmanStream(
  br: BitReaderLE,
  table: HuffmanTable,
  out: Uint8Array,
  outStart: number,
  count: number,
  endByte: number,
): void {
  let accum = 0;
  let held = 0;
  for (let i = 0; i < count; i++) {
    while (held < table.log && br.pos < endByte) {
      accum |= br.data[br.pos++] << held;
      held += 8;
    }
    const window = accum & ((1 << table.log) - 1);
    out[outStart + i] = table.symbols[window];
    const nbits = table.numberOfBits[window];
    accum >>>= nbits;
    held -= nbits;
  }
}

// ---- Sequence tables (RFC §4.8.2) ----

interface SequenceTables {
  ll: FseTable;
  ml: FseTable;
  of: FseTable;
}

interface PersistedTables {
  ll: FseTable | undefined;
  of: FseTable | undefined;
  ml: FseTable | undefined;
}

/**
 * Resolve one FSE sequence table from its 2-bit mode.
 *   0 predefined, 1 raw distribution, 2 reuse previous block's table,
 *   3 dual distribution (rare; reported clearly rather than misdecoded).
 */
function resolveTable(
  block: Uint8Array,
  pos: number,
  mode: number,
  maxLog: number,
  predefined: FseTable,
  previous: FseTable | undefined,
): { table: FseTable; pos: number } {
  if (mode === 0) return { table: predefined, pos };
  if (mode === 1) {
    const d = decodeDistribution(block, pos, maxLog);
    return { table: buildFseTable(d.weights, d.log), pos: pos + d.bytesConsumed };
  }
  if (mode === 2) {
    if (process.env.ZSTD_DEBUG) console.log('mode2 table maxLog=', maxLog, 'pos=', pos, 'byte=', block[pos], 'hasPrev=', !!previous);
    // Reuse the previous block's table. In a single-block frame there is no
    // predecessor; writers then rely on the predefined distribution, so fall
    // back to it rather than failing.
    if (previous) return { table: previous, pos };
    return { table: predefined, pos };
  }
  throw new ZstdUnsupportedError('FSE dual-distribution (mode 3) sequence tables are not supported');
}

function decodeSequenceTables(
  block: Uint8Array,
  start: number,
  previous: PersistedTables,
): {
  tables: SequenceTables;
  headerLength: number;
  persisted: PersistedTables;
} {
  const control = block[start];
  const llMode = control >>> 6;
  const ofMode = (control >>> 4) & 0x03;
  const mlMode = (control >>> 2) & 0x03;
  let pos = start + 1;

  const llRes = resolveTable(
    block, pos, llMode, 9, buildPredefined(LL_DEFAULT_DIST, LL_DEFAULT_LOG), previous.ll,
  );
  pos = llRes.pos;
  const ofRes = resolveTable(
    block, pos, ofMode, 8, buildPredefined(OF_DEFAULT_DIST, OF_DEFAULT_LOG), previous.of,
  );
  pos = ofRes.pos;
  const mlRes = resolveTable(
    block, pos, mlMode, 9, buildPredefined(ML_DEFAULT_DIST, ML_DEFAULT_LOG), previous.ml,
  );
  pos = mlRes.pos;

  const persisted: PersistedTables = { ll: llRes.table, of: ofRes.table, ml: mlRes.table };
  return { tables: persisted as SequenceTables, headerLength: pos - start, persisted };
}

const LL_BASE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128,
  160, 192, 224, 0, 0, 0, 0, 0, 0, 0,
];
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 0, 0,
  0, 0, 0, 0, 0, 0,
];
const ML_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const OF_BASE = [
  1, 1, 5, 21, 85, 341, 1365, 5461, 21845, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0,
];
const OF_BITS = [
  0, 0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

interface Sequence {
  literalLength: number;
  matchLength: number;
  offsetCode: number;
}

function readReverseBits(data: Uint8Array, startBit: number, nbits: number): number {
  let v = 0;
  for (let i = 0; i < nbits; i++) {
    const byteIdx = (startBit + i) >>> 3;
    v |= ((data[byteIdx] >>> ((startBit + i) & 7)) & 1) << i;
  }
  return v >>> 0;
}

function decodeSequences(
  block: Uint8Array,
  start: number,
  sequenceCount: number,
  tables: SequenceTables,
  literalsLength: number,
): { sequences: Sequence[]; bytesConsumed: number } {
  const { ll, ml, of } = tables;
  let bitCursor = start * 8;
  const stateLL = readReverseBits(block, bitCursor, ll.log);
  bitCursor += ll.log;
  const stateML = readReverseBits(block, bitCursor, ml.log);
  bitCursor += ml.log;
  const stateOF = readReverseBits(block, bitCursor, of.log);
  bitCursor += of.log;
  // FSE states start on a byte boundary; remaining padding bits are skipped.
  const br = new BitReaderLE(block, Math.ceil(bitCursor / 8));

  let sLL = stateLL;
  let sML = stateML;
  let sOF = stateOF;
  const sequences: Sequence[] = [];
  let totalLiterals = 0;

  for (let i = 0; i < sequenceCount; i++) {
    const llSym = ll.symbols[sLL];
    const mlSym = ml.symbols[sML];
    const ofSym = of.symbols[sOF];

    const extraLit = i === sequenceCount - 1 ? literalsLength - totalLiterals : 0;
    const literalLength = LL_BASE[llSym] + br.bits(LL_BITS[llSym]) + extraLit;
    const matchLength = ML_BASE[mlSym] + br.bits(ML_BITS[mlSym]);
    const offsetCode = OF_BASE[ofSym] + br.bits(OF_BITS[ofSym]);
    totalLiterals += literalLength;
    sequences.push({ literalLength, matchLength, offsetCode });

    if (i < sequenceCount - 1) {
      sLL = (ll.newState[sLL] << ll.numberOfBits[sLL]) + br.bits(ll.numberOfBits[sLL]);
      sML = (ml.newState[sML] << ml.numberOfBits[sML]) + br.bits(ml.numberOfBits[sML]);
      sOF = (of.newState[sOF] << of.numberOfBits[sOF]) + br.bits(of.numberOfBits[sOF]);
    }
  }
  br.align();
  return { sequences, bytesConsumed: br.pos - start };
}

// ---- Frame orchestration ----

function readNBytes(reader: ByteReader, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v |= reader.u8() << (8 * i);
  return v >>> 0;
}

export function decompressZstd(input: Uint8Array, expectedSize: number): Uint8Array {
  const reader = new ByteReader(input);
  // Frame magic is stored big-endian; block headers below are little-endian.
  const magic =
    (reader.u8() << 24) | (reader.u8() << 16) | (reader.u8() << 8) | reader.u8();
  if (magic !== ZSTD_MAGIC) {
    throw new ZstdUnsupportedError(
      `not a zstd frame (magic 0x${(magic >>> 0).toString(16)}; expected 0x28b52ffd)`,
    );
  }
  const descriptor = reader.u8();
  const singleSegment = (descriptor & 0x20) !== 0;
  const contentChecksum = (descriptor & 0x04) !== 0;
  const dictIdFlag = descriptor & 0x03;
  const fcsFlag = descriptor >>> 6;

  let windowSize: number;
  let frameContentSize: number | undefined;
  if (!singleSegment) {
    const wd = reader.u8();
    const exponent = wd >>> 3;
    const mantissa = wd & 0x07;
    const base = 1 << (10 + exponent);
    windowSize = base + (base / 8) * mantissa;
    if (windowSize > MAX_WINDOW_SIZE) throw new ZstdUnsupportedError('window > 1 GiB');
  } else {
    const bytes = fcsFlag === 0 ? 1 : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    frameContentSize = readNBytes(reader, bytes);
    windowSize = frameContentSize;
  }
  if (!singleSegment && fcsFlag === 2) frameContentSize = readNBytes(reader, 4);
  if (!singleSegment && fcsFlag === 3) {
    const lo = readNBytes(reader, 4);
    const hi = readNBytes(reader, 4);
    frameContentSize = lo + hi * 4294967296;
    if (frameContentSize > Number.MAX_SAFE_INTEGER) {
      throw new ZstdUnsupportedError('frame content > 2^53');
    }
  }
  if (dictIdFlag > 0) {
    const bytes = dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4;
    const id = readNBytes(reader, bytes);
    if (id !== 0) throw new ZstdUnsupportedError('zstd dictionary IDs are not supported');
  }

  const capacity = expectedSize || frameContentSize || windowSize;
  const output = new Uint8Array(capacity);
  let outPos = 0;
  const historyOffsets = [0, 0, 0];
  // FSE tables persist across compressed blocks within a frame (for mode 2).
  const previousTables: PersistedTables = { ll: undefined, of: undefined, ml: undefined };

  for (;;) {
    // Block header is exactly 3 little-endian bytes.
    const blockHeader = reader.u8() | (reader.u8() << 8) | (reader.u8() << 16);
    const lastBlock = (blockHeader & 1) === 1;
    const blockType = (blockHeader >>> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockSize > MAX_BLOCK_SIZE) {
      throw new ZstdUnsupportedError(`block size ${blockSize} > 128 KiB`);
    }

    if (blockType === BLOCK_RAW) {
      output.set(reader.take(blockSize), outPos);
      outPos += blockSize;
    } else if (blockType === BLOCK_RLE) {
      output.fill(reader.u8(), outPos, outPos + blockSize);
      outPos += blockSize;
    } else if (blockType === BLOCK_COMPRESSED) {
      const compressed = reader.slice(blockSize);
      outPos += decodeCompressedBlock(
        compressed, output, outPos, historyOffsets, previousTables,
      );
    } else {
      throw new ZstdUnsupportedError('reserved zstd block type');
    }
    if (lastBlock) break;
  }

  if (contentChecksum) reader.offset += 4;
  if (expectedSize > 0 && outPos !== expectedSize) {
    throw new Error(`zstd output size mismatch: wrote ${outPos}, expected ${expectedSize}`);
  }
  if (frameContentSize !== undefined && outPos !== frameContentSize) {
    throw new Error(`zstd frame content size mismatch: wrote ${outPos}, header ${frameContentSize}`);
  }
  return output.subarray(0, outPos);
}

function decodeCompressedBlock(
  block: Uint8Array,
  output: Uint8Array,
  outStart: number,
  historyOffsets: number[],
  previousTables: PersistedTables,
): number {
  const literals = decodeLiterals(block, 0);
  let pos = literals.sectionLength;

  let sequenceCount: number;
  if (pos >= block.length) {
    sequenceCount = 0;
  } else {
    const h = block[pos];
    if (h === 0) {
      sequenceCount = 0;
      pos += 1;
    } else if (h < 128) {
      sequenceCount = h;
      pos += 1;
    } else if (h < 255) {
      sequenceCount = ((h - 128) << 8) | block[pos + 1];
      pos += 2;
    } else {
      sequenceCount = block[pos + 1] | (block[pos + 2] << 8);
      pos += 3;
    }
  }

  if (sequenceCount === 0) {
    output.set(literals.literals, outStart);
    return literals.literals.length;
  }

  const tableResult = decodeSequenceTables(block, pos, previousTables);
  pos += tableResult.headerLength;
  Object.assign(previousTables, tableResult.persisted);
  const seqResult = decodeSequences(
    block,
    pos,
    sequenceCount,
    tableResult.tables,
    literals.literals.length,
  );
  return executeSequences(
    seqResult.sequences,
    literals.literals,
    output,
    outStart,
    historyOffsets,
  );
}

function executeSequences(
  sequences: Sequence[],
  literals: Uint8Array,
  output: Uint8Array,
  outStart: number,
  historyOffsets: number[],
): number {
  let outPos = outStart;
  let litPos = 0;
  let [o1, o2, o3] = historyOffsets;

  for (const seq of sequences) {
    output.set(literals.subarray(litPos, litPos + seq.literalLength), outPos);
    outPos += seq.literalLength;
    litPos += seq.literalLength;

    let resolved = 0;
    const code = seq.offsetCode;
    if (code === 0) {
      resolved = o1;
      // Repeat the most recent offset; history order is unchanged.
    } else if (code === 1) {
      resolved = o2;
      o2 = o1;
      o1 = resolved;
    } else if (code === 2) {
      resolved = o3;
      o3 = o2;
      o2 = o1;
      o1 = resolved;
    } else if (code === 3) {
      resolved = outPos === outStart ? 1 : o1 - 1;
      o3 = o2;
      o2 = o1;
      o1 = resolved;
    } else {
      resolved = code - 3;
      o3 = o2;
      o2 = o1;
      o1 = resolved;
    }
    if (resolved === 0 || resolved > outPos) {
      throw new Error(`zstd: invalid match offset ${resolved} at output position ${outPos}`);
    }
    for (let i = 0; i < seq.matchLength; i++) {
      output[outPos] = output[outPos - resolved];
      outPos++;
    }
  }
  if (litPos < literals.length) {
    output.set(literals.subarray(litPos), outPos);
    outPos += literals.length - litPos;
  }
  historyOffsets[0] = o1;
  historyOffsets[1] = o2;
  historyOffsets[2] = o3;
  return outPos - outStart;
}
