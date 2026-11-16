// Column chunk reading: page traversal, dictionary pages, RLE/bit-packed
// definition & repetition levels, and data encoding dispatch.

import { ByteReader, RandomAccessFile } from './io.js';
import { decompressPage } from './codecs.js';
import {
  decodeDeltaBinaryPacked32,
  decodeDeltaBinaryPacked64,
  decodeDeltaByteArray,
  decodeDeltaLengthByteArray,
  decodeHybridWithLengthPrefix,
  decodeLegacyBitPacked,
  decodeRleBitPackedHybrid,
} from './encodings.js';
import { readPageHeader } from './metadata.js';
import {
  ColumnChunk,
  CompressionCodec,
  Encoding,
  PageHeader,
  PageType,
  SchemaNode,
  Type,
} from './types.js';
import {
  DecodedValue,
  Int64Value,
  decodePlainValues,
  toLogical,
} from './value.js';

export interface PageInfo {
  ordinal: number;
  header: PageHeader;
  /** Number of level records the page contributes. */
  numValues: number;
  /** Rows (top-level records) the page contributes (V2 only, otherwise inferred). */
  numRows?: number;
  numNulls: number;
  encoding: Encoding;
  compressedSize: number;
  uncompressedSize: number;
  headerOffset: number;
  bodyOffset: number;
  /** When true, the page's compression could not be handled (error stored). */
  decompressionError?: string;
}

export interface ColumnReadResult {
  node: SchemaNode;
  /** One entry per level record (numValues across pages). */
  definitionLevels: number[];
  repetitionLevels: number[];
  /** One logical value per non-null record, in record order. */
  values: DecodedValue[];
  pages: PageInfo[];
  numRows: number;
  numNulls: number;
  chunk: ColumnChunk;
  /** Raw physical values (pre logical conversion) for statistics checks. */
  physicalValues: DecodedValue[];
}

function bitWidthForMaxLevel(maxLevel: number): number {
  if (maxLevel <= 0) return 0;
  return Math.ceil(Math.log2(maxLevel + 1));
}

interface LevelStreams {
  defs: number[];
  reps: number[];
  /** Offset in the (decompressed for v1) body where encoded data begins. */
  dataOffset: number;
}

function readLevelsV1(
  body: Uint8Array,
  page: PageHeader,
  node: SchemaNode,
): LevelStreams {
  const hdr = page.dataPageHeader!;
  const reader = new ByteReader(body);
  let reps: number[] = [];
  if (node.maxRepetitionLevel > 0) {
    const bw = bitWidthForMaxLevel(node.maxRepetitionLevel);
    if (hdr.repetitionLevelEncoding === Encoding.RLE) {
      reps = decodeHybridWithLengthPrefix(body.subarray(reader.offset), bw, hdr.numValues);
      reader.offset += 4 + bodyLengthOfPrefix(body, reader.offset);
    } else if (hdr.repetitionLevelEncoding === Encoding.BIT_PACKED) {
      // Legacy: no length prefix; ceil(numValues/8)*bw bytes.
      const byteLen = Math.ceil((hdr.numValues * bw) / 8);
      reps = decodeLegacyBitPacked(body.subarray(reader.offset, reader.offset + byteLen), bw, hdr.numValues);
      reader.offset += byteLen;
    } else {
      throw new Error(`unsupported repetition level encoding ${Encoding[hdr.repetitionLevelEncoding]}`);
    }
  }
  let defs: number[] = [];
  if (node.maxDefinitionLevel > 0) {
    const bw = bitWidthForMaxLevel(node.maxDefinitionLevel);
    if (hdr.definitionLevelEncoding === Encoding.RLE) {
      const start = reader.offset;
      defs = decodeHybridWithLengthPrefix(body.subarray(start), bw, hdr.numValues);
      reader.offset = start + 4 + new ByteReader(body.subarray(start)).u32();
    } else if (hdr.definitionLevelEncoding === Encoding.BIT_PACKED) {
      const byteLen = Math.ceil((hdr.numValues * bw) / 8);
      defs = decodeLegacyBitPacked(body.subarray(reader.offset, reader.offset + byteLen), bw, hdr.numValues);
      reader.offset += byteLen;
    } else {
      throw new Error(`unsupported definition level encoding ${Encoding[hdr.definitionLevelEncoding]}`);
    }
  } else {
    defs = new Array(hdr.numValues).fill(0);
  }
  if (reps.length === 0 && node.maxRepetitionLevel === 0) {
    reps = new Array(hdr.numValues).fill(0);
  }
  return { defs, reps, dataOffset: reader.offset };
}

function bodyLengthOfPrefix(body: Uint8Array, at: number): number {
  return new ByteReader(body.subarray(at)).u32();
}

function readLevelsV2(
  compressedBody: Uint8Array,
  decompressedBody: Uint8Array,
  page: PageHeader,
  node: SchemaNode,
  isCompressed: boolean,
): LevelStreams {
  const hdr = page.dataPageHeaderV2!;
  const repLen = hdr.repetitionLevelsByteLength;
  const defLen = hdr.definitionLevelsByteLength;
  // V2 levels are never compressed.
  const repSource = isCompressed ? compressedBody : decompressedBody;
  let reps: number[] = [];
  let offset = 0;
  if (node.maxRepetitionLevel > 0) {
    const bw = bitWidthForMaxLevel(node.maxRepetitionLevel);
    reps = decodeRleBitPackedHybrid(repSource.subarray(0, repLen), bw, hdr.numValues);
  } else {
    reps = new Array(hdr.numValues).fill(0);
  }
  offset = repLen;
  let defs: number[];
  if (node.maxDefinitionLevel > 0) {
    const bw = bitWidthForMaxLevel(node.maxDefinitionLevel);
    defs = decodeRleBitPackedHybrid(
      repSource.subarray(offset, offset + defLen),
      bw,
      hdr.numValues,
    );
  } else {
    defs = new Array(hdr.numValues).fill(0);
  }
  offset += defLen;
  return { defs, reps, dataOffset: offset };
}

// ---- Data payload decoders ----

function decodeDataPayload(
  body: Uint8Array,
  offset: number,
  encoding: Encoding,
  node: SchemaNode,
  nonNullCount: number,
  dictionary: DecodedValue[] | undefined,
): DecodedValue[] {
  const physical = node.physicalType!;
  const payload = body.subarray(offset);

  switch (encoding) {
    case Encoding.PLAIN:
      return decodePlainValues(payload, physical, nonNullCount, node.typeLength);

    case Encoding.PLAIN_DICTIONARY:
    case Encoding.RLE_DICTIONARY: {
      if (!dictionary) throw new Error('dictionary-encoded page without a dictionary');
      // Data-page dictionary indices: one bit-width byte followed directly by
      // the RLE/bit-packed hybrid stream with NO 4-byte length prefix (the
      // prefix form only appears in dictionary-page header contexts).
      const bitWidth = payload[0];
      const stream = payload.subarray(1);
      const indices = decodeRleBitPackedHybrid(stream, bitWidth, nonNullCount);
      return indices.map((idx) => {
        if (idx >= dictionary.length) {
          throw new Error(`dictionary index ${idx} out of range (size ${dictionary.length})`);
        }
        return dictionary[idx];
      });
    }

    case Encoding.RLE: {
      // BOOLEAN only. RLE-encoded booleans use the length-prefixed hybrid
      // stream layout (4-byte little-endian length then the run stream).
      if (physical !== Type.BOOLEAN) {
        throw new Error(`RLE data encoding is only valid for BOOLEAN, got ${Type[physical]}`);
      }
      const bits = decodeHybridWithLengthPrefix(payload, 1, nonNullCount);
      return bits.map((b) => b === 1);
    }

    case Encoding.BIT_PACKED: {
      if (physical !== Type.BOOLEAN) {
        throw new Error(`legacy BIT_PACKED data is only valid for BOOLEAN, got ${Type[physical]}`);
      }
      const bits = decodeLegacyBitPacked(payload, 1, nonNullCount);
      return bits.map((b) => b === 1);
    }

    case Encoding.DELTA_BINARY_PACKED: {
      if (physical === Type.INT64) {
        return decodeDeltaBinaryPacked64(payload).map((v) => new Int64Value(v));
      }
      const nums = decodeDeltaBinaryPacked32(payload);
      if (nums.length !== nonNullCount) {
        throw new Error(`DELTA_BINARY_PACKED count ${nums.length} != ${nonNullCount}`);
      }
      if (physical === Type.INT32) return nums;
      if (physical === Type.FLOAT) {
        // Rare: reinterpret via DataView after re-encoding not needed 鈥?Parquet
        // forbids delta on FLOAT; reject explicitly rather than misread.
        throw new Error('DELTA_BINARY_PACKED is not valid for FLOAT');
      }
      return nums;
    }

    case Encoding.DELTA_LENGTH_BYTE_ARRAY: {
      if (physical !== Type.BYTE_ARRAY) {
        throw new Error('DELTA_LENGTH_BYTE_ARRAY requires BYTE_ARRAY');
      }
      const arrays = decodeDeltaLengthByteArray(payload);
      if (arrays.length !== nonNullCount) {
        throw new Error(`DELTA_LENGTH_BYTE_ARRAY count ${arrays.length} != ${nonNullCount}`);
      }
      return arrays;
    }

    case Encoding.DELTA_BYTE_ARRAY: {
      if (physical !== Type.BYTE_ARRAY && physical !== Type.FIXED_LEN_BYTE_ARRAY) {
        throw new Error('DELTA_BYTE_ARRAY requires a byte-array physical type');
      }
      const arrays = decodeDeltaByteArray(payload);
      if (arrays.length !== nonNullCount) {
        throw new Error(`DELTA_BYTE_ARRAY count ${arrays.length} != ${nonNullCount}`);
      }
      return arrays;
    }

    default:
      throw new Error(`unsupported data encoding ${Encoding[encoding]} (${encoding})`);
  }
}

export function decodeDictionaryPage(
  body: Uint8Array,
  page: PageHeader,
  node: SchemaNode,
): DecodedValue[] {
  const hdr = page.dictionaryPageHeader!;
  const physical = node.physicalType!;
  // An all-null column may carry an empty dictionary page.
  if (hdr.numValues === 0 || body.length === 0) return [];
  switch (hdr.encoding) {
    case Encoding.PLAIN:
    case Encoding.PLAIN_DICTIONARY:
      return decodePlainValues(body, physical, hdr.numValues, node.typeLength);
    case Encoding.DELTA_BYTE_ARRAY:
      return decodeDeltaByteArray(body);
    case Encoding.DELTA_LENGTH_BYTE_ARRAY:
      return decodeDeltaLengthByteArray(body);
    case Encoding.DELTA_BINARY_PACKED:
      if (physical === Type.INT64) {
        return decodeDeltaBinaryPacked64(body).map((v) => new Int64Value(v));
      }
      return decodeDeltaBinaryPacked32(body);
    default:
      throw new Error(`unsupported dictionary encoding ${Encoding[hdr.encoding]}`);
  }
}

export interface ReadColumnOptions {
  onPageRead?: (info: PageInfo) => void;
  /** Skip value decoding (levels + page inventory only). */
  metadataOnly?: boolean;
}

export async function readColumnChunk(
  file: RandomAccessFile,
  chunk: ColumnChunk,
  node: SchemaNode,
  options: ReadColumnOptions = {},
): Promise<ColumnReadResult> {
  const meta = chunk.metaData;
  if (!meta) throw new Error('column chunk without embedded metadata is not supported');
  const codec = meta.codec;

  const startOffset = Number(
    meta.dictionaryPageOffset !== undefined
      ? meta.dictionaryPageOffset
      : meta.dataPageOffset,
  );
  // totalCompressedSize covers every page from the first (dictionary, if any)
  // page onward, so the end is measured from the same start point.
  const columnEnd = startOffset + Number(meta.totalCompressedSize);

  const defs: number[] = [];
  const reps: number[] = [];
  const physicalValues: DecodedValue[] = [];
  const pages: PageInfo[] = [];
  let dictionary: DecodedValue[] | undefined;
  let pageOrdinal = 0;
  let offset = startOffset;
  let numNulls = 0;

  while (offset < columnEnd) {
    const { header } = await readPageHeader(file, offset);
    const bodyOffset = header.bodyOffset;
    const compressed = await file.readAt(bodyOffset, header.compressedPageSize);
    const label = `row group column '${meta.pathInSchema.join('.')}', ${PageType[header.type]} page ${pageOrdinal}`;

    let body: Uint8Array;
    let decompressionError: string | undefined;
    // Data page v2 can mark itself uncompressed even when the column codec is
    // set; the level bytes are always stored raw regardless.
    const v2Uncompressed =
      header.type === PageType.DATA_PAGE_V2 &&
      (header.dataPageHeaderV2?.isCompressed ?? true) === false;
    try {
      if (v2Uncompressed || codec === CompressionCodec.UNCOMPRESSED) {
        body = compressed;
      } else {
        body = await decompressPage(compressed, {
          codec,
          pageLabel: label,
          uncompressedSize: header.uncompressedPageSize,
        });
      }
    } catch (err) {
      if (codec === CompressionCodec.ZSTD || err instanceof Error) {
        decompressionError = err instanceof Error ? err.message : String(err);
        body = new Uint8Array(header.uncompressedPageSize);
      } else {
        throw err;
      }
    }

    if (header.type === PageType.DICTIONARY_PAGE) {
      if (!decompressionError) {
        dictionary = decodeDictionaryPage(body, header, node);
      }
      pages.push({
        ordinal: pageOrdinal++,
        header,
        numValues: header.dictionaryPageHeader!.numValues,
        numNulls: 0,
        encoding: header.dictionaryPageHeader!.encoding,
        compressedSize: header.compressedPageSize,
        uncompressedSize: header.uncompressedPageSize,
        headerOffset: offset,
        bodyOffset,
        decompressionError,
      });
    } else if (header.type === PageType.DATA_PAGE) {
      const hdr = header.dataPageHeader!;
      const levels = readLevelsV1(body, header, node);
      const nonNullCount = countNonNull(levels.defs, node);
      numNulls += countNulls(levels.defs, node);

      let pagePhysical: DecodedValue[] = [];
      if (!decompressionError && !options.metadataOnly) {
        try {
          pagePhysical = decodeDataPayload(
            body,
            levels.dataOffset,
            hdr.encoding,
            node,
            nonNullCount,
            dictionary,
          );
        } catch (err) {
          // A page whose data cannot be decoded (e.g. an unsupported zstd
          // dictionary backing) is reported but does not abort the column.
          decompressionError = err instanceof Error ? err.message : String(err);
          pagePhysical = new Array(nonNullCount).fill(null);
        }
      }
      mergePage(defs, reps, physicalValues, levels, pagePhysical, node);
      pages.push({
        ordinal: pageOrdinal++,
        header,
        numValues: hdr.numValues,
        numNulls: countNulls(levels.defs, node),
        encoding: hdr.encoding,
        compressedSize: header.compressedPageSize,
        uncompressedSize: header.uncompressedPageSize,
        headerOffset: offset,
        bodyOffset,
        decompressionError,
      });
    } else if (header.type === PageType.DATA_PAGE_V2) {
      const hdr = header.dataPageHeaderV2!;
      const isCompressed = hdr.isCompressed ?? true;
      const levels = readLevelsV2(compressed, body, header, node, isCompressed);
      const nonNullCount = countNonNull(levels.defs, node);
      numNulls += countNulls(levels.defs, node);

      let pagePhysical: DecodedValue[] = [];
      if (!decompressionError && !options.metadataOnly) {
        try {
          pagePhysical = decodeDataPayload(
            body,
            levels.dataOffset,
            hdr.encoding,
            node,
            nonNullCount,
            dictionary,
          );
        } catch (err) {
          // A page whose data cannot be decoded (e.g. an unsupported zstd
          // dictionary backing) is reported but does not abort the column.
          decompressionError = err instanceof Error ? err.message : String(err);
          pagePhysical = new Array(nonNullCount).fill(null);
        }
      }
      mergePage(defs, reps, physicalValues, levels, pagePhysical, node);
      pages.push({
        ordinal: pageOrdinal++,
        header,
        numValues: hdr.numValues,
        numRows: hdr.numRows,
        numNulls: countNulls(levels.defs, node),
        encoding: hdr.encoding,
        compressedSize: header.compressedPageSize,
        uncompressedSize: header.uncompressedPageSize,
        headerOffset: offset,
        bodyOffset,
        decompressionError,
      });
    } else {
      // INDEX_PAGE etc.: skip.
      pages.push({
        ordinal: pageOrdinal++,
        header,
        numValues: 0,
        numNulls: 0,
        encoding: -1 as Encoding,
        compressedSize: header.compressedPageSize,
        uncompressedSize: header.uncompressedPageSize,
        headerOffset: offset,
        bodyOffset,
        decompressionError,
      });
    }

    options.onPageRead?.(pages[pages.length - 1]);
    offset = bodyOffset + header.compressedPageSize;
  }

  const values = options.metadataOnly
    ? []
    : physicalValues.map((v) => toLogical(v, node));

  const numRows = computeRowCount(reps, node, Number(meta.numValues));

  return {
    node,
    definitionLevels: defs,
    repetitionLevels: reps,
    values,
    physicalValues,
    pages,
    numRows,
    numNulls,
    chunk,
  };
}

function countNonNull(defs: number[], node: SchemaNode): number {
  let count = 0;
  for (const d of defs) if (d === node.maxDefinitionLevel) count++;
  return count;
}

/** Top-level nulls: records below the field's presence definition level. */
function countNulls(defs: number[], node: SchemaNode): number {
  let count = 0;
  for (const d of defs) if (d < node.nullDefinitionLevel) count++;
  return count;
}

function mergePage(
  defs: number[],
  reps: number[],
  physicalValues: DecodedValue[],
  levels: LevelStreams,
  pageValues: DecodedValue[],
  node: SchemaNode,
): void {
  let valueCursor = 0;
  for (let i = 0; i < levels.defs.length; i++) {
    defs.push(levels.defs[i]);
    reps.push(levels.reps[i]);
    if (levels.defs[i] === node.maxDefinitionLevel) {
      physicalValues.push(pageValues[valueCursor++]);
    } else {
      physicalValues.push(null);
    }
  }
  if (valueCursor !== pageValues.length) {
    throw new Error(
      `page value accounting mismatch: consumed ${valueCursor} of ${pageValues.length} values`,
    );
  }
}

/** Top-level rows = records whose repetition level is 0. */
function computeRowCount(reps: number[], node: SchemaNode, fallback: number): number {
  if (node.maxRepetitionLevel === 0) {
    return fallback;
  }
  let rows = 0;
  for (const r of reps) if (r === 0) rows++;
  return rows;
}

