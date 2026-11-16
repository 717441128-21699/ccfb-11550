// Footer parsing: magic bytes, Thrift FileMetaData, schema-tree construction
// and definition/repetition level bookkeeping.

import { ByteReader } from './io.js';
import type { RandomAccessFile } from './io.js';
import { decodeCompactStruct, THRIFT_DEFS } from './thrift.js';
import {
  CompressionCodec,
  ConvertedType,
  Encoding,
  FieldRepetitionType,
  FileMetaData,
  LogicalType,
  PageHeader,
  PageType,
  PARQUET_MAGIC,
  RowGroup,
  SchemaNode,
  SchemaElement,
  Statistics,
  TimeUnit,
  Type,
} from './types.js';

const FOOTER_TAIL_SIZE = 8;

export interface FooterResult {
  metadata: FileMetaData;
  /** Absolute byte range of the serialized Thrift footer (for the UI). */
  footerOffset: number;
  footerLength: number;
}

async function readMagicAt(file: RandomAccessFile, pos: number): Promise<string> {
  const bytes = await file.readAt(pos, 4);
  return new TextDecoder().decode(bytes);
}

export async function readFooter(file: RandomAccessFile): Promise<FooterResult> {
  if (file.size < 12) {
    throw new Error(`file too small to be Parquet (${file.size} bytes); need at least 12`);
  }
  const headMagic = await readMagicAt(file, 0);
  if (headMagic !== PARQUET_MAGIC) {
    throw new Error(
      `bad leading magic: expected "PAR1", got ${JSON.stringify(headMagic)}. Not a Parquet file.`,
    );
  }
  const tail = await file.readAt(file.size - FOOTER_TAIL_SIZE, FOOTER_TAIL_SIZE);
  const tailReader = new ByteReader(tail);
  const footerLength = tailReader.i32();
  const tailMagic = new TextDecoder().decode(tailReader.slice(4));
  if (tailMagic !== PARQUET_MAGIC) {
    throw new Error(
      `bad trailing magic: expected "PAR1", got ${JSON.stringify(tailMagic)}. Not a Parquet file.`,
    );
  }
  const footerOffset = file.size - FOOTER_TAIL_SIZE - footerLength;
  if (footerOffset < 4) {
    throw new Error(`footer length ${footerLength} extends past file start`);
  }
  const footerBytes = await file.readAt(footerOffset, footerLength);
  const reader = new ByteReader(footerBytes);
  const raw = decodeCompactStruct<Record<string, unknown>>(reader, THRIFT_DEFS.fileMetaData);
  if (reader.remaining !== 0) {
    throw new Error(`footer has ${reader.remaining} trailing bytes after FileMetaData`);
  }
  const metadata = convertFileMetaData(raw);
  return { metadata, footerOffset, footerLength };
}

function asNum(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  return Number(v);
}

function asBig(v: unknown): bigint | undefined {
  if (v === undefined) return undefined;
  return BigInt(v as number | bigint);
}

function asStr(v: unknown): string | undefined {
  return v === undefined ? undefined : String(v);
}

function convertLogicalType(raw: Record<string, unknown> | undefined): LogicalType | undefined {
  if (!raw) return undefined;
  if ('STRING' in raw) return { type: 'STRING' };
  if ('MAP' in raw) return { type: 'MAP' };
  if ('LIST' in raw) return { type: 'LIST' };
  if ('ENUM' in raw) return { type: 'ENUM' };
  if ('JSON' in raw) return { type: 'JSON' };
  if ('BSON' in raw) return { type: 'BSON' };
  if ('UUID' in raw) return { type: 'UUID' };
  if ('FLOAT16' in raw) return { type: 'FLOAT16' };
  if ('UNKNOWN' in raw) return { type: 'UNKNOWN' };
  if ('DATE' in raw) return { type: 'DATE' };
  if ('DECIMAL' in raw) {
    const d = raw.DECIMAL as Record<string, unknown>;
    return {
      type: 'DECIMAL',
      precision: Number(d.precision),
      scale: Number(d.scale),
    };
  }
  if ('TIME' in raw) {
    const t = raw.TIME as Record<string, unknown>;
    return {
      type: 'TIME',
      isAdjustedToUTC: Boolean(t.isAdjustedToUTC),
      unit: convertTimeUnit(t.unit as Record<string, unknown>),
    };
  }
  if ('TIMESTAMP' in raw) {
    const t = raw.TIMESTAMP as Record<string, unknown>;
    return {
      type: 'TIMESTAMP',
      isAdjustedToUTC: Boolean(t.isAdjustedToUTC),
      unit: convertTimeUnit(t.unit as Record<string, unknown>),
    };
  }
  if ('INTEGER' in raw) {
    const i = raw.INTEGER as Record<string, unknown>;
    return {
      type: 'INTEGER',
      bitWidth: Number(i.bitWidth) as 8 | 16 | 32 | 64,
      isSigned: Boolean(i.isSigned),
    };
  }
  return undefined;
}

function convertTimeUnit(raw: Record<string, unknown>): TimeUnit {
  if ('MILLIS' in raw) return { kind: 'MILLIS' };
  if ('MICROS' in raw) return { kind: 'MICROS' };
  if ('NANOS' in raw) return { kind: 'NANOS' };
  throw new Error('TimeUnit union missing all members');
}

function convertSchemaElement(raw: Record<string, unknown>): SchemaElement {
  const el: SchemaElement = { name: String(raw.name) };
  if (raw.type !== undefined) el.type = asNum(raw.type) as Type;
  if (raw.typeLength !== undefined) el.typeLength = asNum(raw.typeLength);
  if (raw.repetitionType !== undefined) {
    el.repetitionType = asNum(raw.repetitionType) as FieldRepetitionType;
  }
  if (raw.numChildren !== undefined) el.numChildren = asNum(raw.numChildren);
  if (raw.convertedType !== undefined) {
    el.convertedType = asNum(raw.convertedType) as ConvertedType;
  }
  if (raw.scale !== undefined) el.scale = asNum(raw.scale);
  if (raw.precision !== undefined) el.precision = asNum(raw.precision);
  if (raw.fieldId !== undefined) el.fieldId = asNum(raw.fieldId);
  const logical = convertLogicalType(raw.logicalType as Record<string, unknown> | undefined);
  if (logical) el.logicalType = logical;
  return el;
}

function convertStatistics(raw: Record<string, unknown> | undefined): Statistics | undefined {
  if (!raw) return undefined;
  const out: Statistics = {};
  if (raw.max !== undefined) out.max = raw.max as Uint8Array;
  if (raw.min !== undefined) out.min = raw.min as Uint8Array;
  if (raw.maxValue !== undefined) out.maxValue = raw.maxValue as Uint8Array;
  if (raw.minValue !== undefined) out.minValue = raw.minValue as Uint8Array;
  if (raw.nullCount !== undefined) out.nullCount = asBig(raw.nullCount);
  if (raw.distinctCount !== undefined) out.distinctCount = asBig(raw.distinctCount);
  return out;
}

function convertFileMetaData(raw: Record<string, unknown>): FileMetaData {
  const schema = (raw.schema as Record<string, unknown>[]).map(convertSchemaElement);
  const rowGroups: RowGroup[] = (raw.rowGroups as Record<string, unknown>[]).map((rg) => {
    const columns = (rg.columns as Record<string, unknown>[]).map((cc) => {
      const chunk: FileMetaData['rowGroups'][number]['columns'][number] = {
        fileOffset: asBig(cc.fileOffset) ?? 0n,
      };
      if (cc.filePath !== undefined) chunk.filePath = asStr(cc.filePath);
      if (cc.offsetIndexOffset !== undefined) chunk.offsetIndexOffset = asBig(cc.offsetIndexOffset);
      if (cc.offsetIndexLength !== undefined) chunk.offsetIndexLength = asNum(cc.offsetIndexLength);
      if (cc.metaData) {
        const m = cc.metaData as Record<string, unknown>;
        chunk.metaData = {
          type: asNum(m.type) as Type,
          encodings: (m.encodings as number[]).map((e) => e as Encoding),
          pathInSchema: m.pathInSchema as string[],
          codec: asNum(m.codec) as CompressionCodec,
          numValues: asBig(m.numValues)!,
          totalUncompressedSize: asBig(m.totalUncompressedSize)!,
          totalCompressedSize: asBig(m.totalCompressedSize)!,
          dataPageOffset: asBig(m.dataPageOffset)!,
          statistics: convertStatistics(m.statistics as Record<string, unknown> | undefined),
        };
        if (m.keyValueMetadata) {
          chunk.metaData.keyValueMetadata = (m.keyValueMetadata as Record<string, unknown>[]).map(
            (kv) => ({ key: String(kv.key), value: kv.value === undefined ? undefined : String(kv.value) }),
          );
        }
        if (m.indexPageOffset !== undefined) chunk.metaData.indexPageOffset = asBig(m.indexPageOffset);
        if (m.dictionaryPageOffset !== undefined) {
          chunk.metaData.dictionaryPageOffset = asBig(m.dictionaryPageOffset);
        }
      }
      return chunk;
    });
    const group: RowGroup = {
      columns,
      totalByteSize: asBig(rg.totalByteSize)!,
      numRows: asBig(rg.numRows)!,
    };
    if (rg.totalCompressedSize !== undefined) group.totalCompressedSize = asBig(rg.totalCompressedSize);
    if (rg.ordinal !== undefined) group.ordinal = asNum(rg.ordinal);
    if (rg.fileOrdinal !== undefined) group.fileOrdinal = asNum(rg.fileOrdinal);
    return group;
  });
  const meta: FileMetaData = {
    version: asNum(raw.version)!,
    schema,
    numRows: asBig(raw.numRows)!,
    rowGroups,
    keyValueMetadata: raw.keyValueMetadata
      ? (raw.keyValueMetadata as Record<string, unknown>[]).map((kv) => ({
          key: String(kv.key),
          value: kv.value === undefined ? undefined : String(kv.value),
        }))
      : [],
  };
  if (raw.createdBy !== undefined) meta.createdBy = asStr(raw.createdBy);
  if (raw.columnOrders) {
    meta.columnOrders = (raw.columnOrders as Record<string, unknown>[]).map((co) => ({
      type: 'TYPE_ORDER' in co ? 'TYPE_ORDER' : 'UNKNOWN',
    }));
  }
  return meta;
}

/**
 * Build the nested schema tree from the flat DFS-ordered SchemaElement list.
 * maxDefinitionLevel counts OPTIONAL/REPEATED nodes on the root-to-leaf path;
 * maxRepetitionLevel counts REPEATED nodes.
 */
export function buildSchemaTree(schema: SchemaElement[]): SchemaNode {
  let cursor = 0;

  function build(
    parentPath: string[],
    parentDef: number,
    parentRep: number,
    inheritedNullLevel: number | null,
  ): SchemaNode {
    const index = cursor++;
    const el = schema[index];
    const path = [...parentPath, el.name];
    const isRepeated = el.repetitionType === FieldRepetitionType.REPEATED;
    const isOptional = el.repetitionType === FieldRepetitionType.OPTIONAL;
    const maxRepetitionLevel = parentRep + (isRepeated ? 1 : 0);
    const maxDefinitionLevel = parentDef + (isOptional || isRepeated ? 1 : 0);
    // The first optional/repeated node below the root is where the top-level
    // field transitions from null to present. Its (post-increment) definition
    // level is the threshold: defs at/above it are present (possibly empty).
    const nullDefinitionLevel =
      inheritedNullLevel !== null
        ? inheritedNullLevel
        : isOptional || isRepeated
          ? maxDefinitionLevel
          : 0;
    const node: SchemaNode = {
      schemaIndex: index,
      name: el.name,
      repetition: el.repetitionType,
      physicalType: el.type,
      typeLength: el.typeLength,
      convertedType: el.convertedType,
      logicalType: el.logicalType,
      scale: el.scale,
      precision: el.precision,
      fieldId: el.fieldId,
      children: [],
      path,
      maxDefinitionLevel,
      maxRepetitionLevel,
      nullDefinitionLevel,
    };
    const childCount = el.numChildren ?? 0;
    // Propagate an established presence threshold; if this node itself is the
    // first optional/repeated node, children inherit this node's level.
    const childInherited =
      inheritedNullLevel !== null
        ? inheritedNullLevel
        : isOptional || isRepeated
          ? maxDefinitionLevel
          : null;
    for (let i = 0; i < childCount; i++) {
      node.children.push(
        build(path, maxDefinitionLevel, maxRepetitionLevel, childInherited),
      );
    }
    return node;
  }

  const root = build([], 0, 0, null);
  if (cursor !== schema.length) {
    throw new Error(`schema tree consumed ${cursor} of ${schema.length} elements`);
  }
  return root;
}

/** DFS list of leaf (physical-column) nodes, in the order column chunks appear. */
export function leafNodes(root: SchemaNode): SchemaNode[] {
  const out: SchemaNode[] = [];
  const walk = (node: SchemaNode): void => {
    if (node.children.length === 0) {
      out.push(node);
    } else {
      node.children.forEach(walk);
    }
  };
  walk(root);
  return out;
}

export async function readPageHeader(
  file: RandomAccessFile,
  offset: number,
): Promise<{ header: PageHeader; bytesRead: number }> {
  // Page headers are small; read a generous window and re-read if needed.
  const windowSize = 256;
  let window = await file.readAt(offset, Math.min(windowSize, file.size - offset));
  let reader = new ByteReader(window);
  let raw: Record<string, unknown>;
  try {
    raw = decodeCompactStruct<Record<string, unknown>>(reader, THRIFT_DEFS.pageHeader);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('end of buffer')) throw err;
    window = await file.readAt(offset, Math.min(4096, file.size - offset));
    reader = new ByteReader(window);
    raw = decodeCompactStruct<Record<string, unknown>>(reader, THRIFT_DEFS.pageHeader);
  }
  const bytesRead = reader.offset;
  const header: PageHeader = {
    type: Number(raw.type) as PageType,
    uncompressedPageSize: Number(raw.uncompressedPageSize),
    compressedPageSize: Number(raw.compressedPageSize),
    headerOffset: offset,
    bodyOffset: offset + bytesRead,
  };
  if (raw.crc !== undefined) header.crc = Number(raw.crc);
  if (raw.dataPageHeader) {
    const d = raw.dataPageHeader as Record<string, unknown>;
    header.dataPageHeader = {
      numValues: Number(d.numValues),
      encoding: Number(d.encoding) as Encoding,
      definitionLevelEncoding: Number(d.definitionLevelEncoding) as Encoding,
      repetitionLevelEncoding: Number(d.repetitionLevelEncoding) as Encoding,
      statistics: convertStatistics(d.statistics as Record<string, unknown> | undefined),
    };
  }
  if (raw.dataPageHeaderV2) {
    const d = raw.dataPageHeaderV2 as Record<string, unknown>;
    header.dataPageHeaderV2 = {
      numValues: Number(d.numValues),
      numNulls: Number(d.numNulls),
      numRows: Number(d.numRows),
      encoding: Number(d.encoding) as Encoding,
      definitionLevelsByteLength: Number(d.definitionLevelsByteLength),
      repetitionLevelsByteLength: Number(d.repetitionLevelsByteLength),
      isCompressed: d.isCompressed === undefined ? undefined : Boolean(d.isCompressed),
      statistics: convertStatistics(d.statistics as Record<string, unknown> | undefined),
    };
  }
  if (raw.dictionaryPageHeader) {
    const d = raw.dictionaryPageHeader as Record<string, unknown>;
    header.dictionaryPageHeader = {
      numValues: Number(d.numValues),
      encoding: Number(d.encoding) as Encoding,
    };
  }
  return { header, bytesRead };
}
