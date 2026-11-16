// Hand-written decoder for the Thrift Compact Protocol used in Parquet footers
// and page headers. No Thrift library: field layouts are declared as descriptors
// matching parquet.thrift.

import { ByteReader, zigzagDecode, zigzagDecodeBig } from './io.js';

// Compact protocol type IDs.
const CT_STOP = 0;
const CT_BOOLEAN_TRUE = 1;
const CT_BOOLEAN_FALSE = 2;
const CT_BYTE = 3;
const CT_I16 = 4;
const CT_I32 = 5;
const CT_I64 = 6;
const CT_DOUBLE = 7;
const CT_BINARY = 8;
const CT_LIST = 9;
const CT_SET = 10;
const CT_MAP = 11;
const CT_STRUCT = 12;

export type FieldKind =
  | 'bool'
  | 'i8'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'double'
  | 'binary'
  | 'string'
  | 'struct'
  | 'list'
  | 'set'
  | 'map';

export interface FieldDef {
  id: number;
  name: string;
  kind: FieldKind;
  /** For kind 'struct'. */
  structDef?: StructDef;
  /** For list/set element types. */
  elemKind?: FieldKind;
  elemStruct?: StructDef;
  /** For maps. */
  keyKind?: FieldKind;
  valueKind?: FieldKind;
  valueStruct?: StructDef;
}

export type StructDef = FieldDef[];

function readCompactValue(reader: ByteReader, ct: number, kind: FieldKind): unknown {
  switch (kind) {
    case 'bool':
      return ct === CT_BOOLEAN_TRUE;
    case 'i8': {
      // Compact protocol sends i8 as a zigzag varint too.
      return zigzagDecode(reader.varint());
    }
    case 'i16':
    case 'i32':
      return zigzagDecode(reader.varint());
    case 'i64':
      return zigzagDecodeBig(reader.varintBig());
    case 'double':
      return reader.double();
    case 'binary': {
      const len = reader.varint();
      return reader.take(len);
    }
    case 'string': {
      const len = reader.varint();
      const bytes = reader.slice(len);
      return new TextDecoder().decode(bytes);
    }
    default:
      throw new Error(`unexpected scalar kind ${kind}`);
  }
}

function readList(reader: ByteReader, def: FieldDef): unknown[] {
  const header = reader.u8();
  let size = header >> 4;
  const elemCt = header & 0x0f;
  if (size === 15) size = reader.varint();
  const out: unknown[] = [];
  for (let i = 0; i < size; i++) {
    out.push(readElement(reader, elemCt, def.elemKind!, def.elemStruct));
  }
  return out;
}

function readMap(reader: ByteReader, def: FieldDef): Map<unknown, unknown> {
  const size = reader.varint();
  const map = new Map<unknown, unknown>();
  if (size === 0) return map;
  const types = reader.u8();
  const keyCt = (types >> 4) & 0x0f;
  const valCt = types & 0x0f;
  for (let i = 0; i < size; i++) {
    const k = readElement(reader, keyCt, def.keyKind!, undefined);
    const v = readElement(reader, valCt, def.valueKind!, def.valueStruct);
    map.set(k, v);
  }
  return map;
}

function readElement(
  reader: ByteReader,
  ct: number,
  kind: FieldKind,
  structDef?: StructDef,
): unknown {
  if (kind === 'struct') {
    if (ct !== CT_STRUCT) throw new Error(`expected struct, got compact type ${ct}`);
    return readStruct(reader, structDef!);
  }
  if (kind === 'list' || kind === 'set') {
    if (ct !== CT_LIST && ct !== CT_SET) {
      throw new Error(`expected list, got compact type ${ct}`);
    }
    return readList(reader, { elemKind: kind === 'list' ? 'struct' : 'struct' } as FieldDef);
  }
  return readCompactValue(reader, ct, kind);
}

export function readStruct(reader: ByteReader, def: StructDef): Record<string, unknown> {
  const byId = new Map<number, FieldDef>();
  for (const f of def) byId.set(f.id, f);
  const out: Record<string, unknown> = {};
  let lastId = 0;
  for (;;) {
    const header = reader.u8();
    if (header === CT_STOP) return out;
    const delta = (header >> 4) & 0x0f;
    const ct = header & 0x0f;
    let id: number;
    if (delta === 0) {
      id = zigzagDecode(reader.varint());
    } else {
      id = lastId + delta;
    }
    lastId = id;
    const field = byId.get(id);
    if (!field) {
      skipValue(reader, ct);
      continue;
    }
    out[field.name] = readFieldValue(reader, ct, field);
  }
}

function readFieldValue(reader: ByteReader, ct: number, field: FieldDef): unknown {
  switch (field.kind) {
    case 'list':
    case 'set':
      if (ct !== CT_LIST && ct !== CT_SET) {
        throw new Error(`field ${field.name}: expected list, got compact type ${ct}`);
      }
      return readList(reader, field);
    case 'map':
      if (ct !== CT_MAP) throw new Error(`field ${field.name}: expected map`);
      return readMap(reader, field);
    case 'struct':
      if (ct !== CT_STRUCT) {
        throw new Error(`field ${field.name}: expected struct, got compact type ${ct}`);
      }
      return readStruct(reader, field.structDef!);
    default:
      return readCompactValue(reader, ct, field.kind);
  }
}

/** Skip an unknown field value. */
function skipValue(reader: ByteReader, ct: number): void {
  switch (ct) {
    case CT_BOOLEAN_TRUE:
    case CT_BOOLEAN_FALSE:
      return;
    case CT_BYTE:
      reader.offset += 1;
      return;
    case CT_I16:
    case CT_I32:
    case CT_I64:
      reader.varintBig();
      return;
    case CT_DOUBLE:
      reader.offset += 8;
      return;
    case CT_BINARY: {
      const len = reader.varint();
      reader.offset += len;
      return;
    }
    case CT_LIST:
    case CT_SET: {
      const header = reader.u8();
      let size = header >> 4;
      const elemCt = header & 0x0f;
      if (size === 15) size = reader.varint();
      for (let i = 0; i < size; i++) skipValue(reader, elemCt);
      return;
    }
    case CT_MAP: {
      const size = reader.varint();
      if (size === 0) return;
      const types = reader.u8();
      const keyCt = (types >> 4) & 0x0f;
      const valCt = types & 0x0f;
      for (let i = 0; i < size; i++) {
        skipValue(reader, keyCt);
        skipValue(reader, valCt);
      }
      return;
    }
    case CT_STRUCT: {
      for (;;) {
        const header = reader.u8();
        if (header === CT_STOP) return;
        const delta = (header >> 4) & 0x0f;
        const innerCt = header & 0x0f;
        if (delta === 0) reader.varint();
        skipValue(reader, innerCt);
      }
    }
    default:
      throw new Error(`unknown compact type ${ct} while skipping`);
  }
}

// ---- parquet.thrift descriptors ----

const statisticsDef: StructDef = [
  { id: 1, name: 'max', kind: 'binary' },
  { id: 2, name: 'min', kind: 'binary' },
  { id: 3, name: 'nullCount', kind: 'i64' },
  { id: 4, name: 'distinctCount', kind: 'i64' },
  { id: 5, name: 'maxValue', kind: 'binary' },
  { id: 6, name: 'minValue', kind: 'binary' },
];

const keyValueDef: StructDef = [
  { id: 1, name: 'key', kind: 'string' },
  { id: 2, name: 'value', kind: 'string' },
];

const timeUnitDef: StructDef = [
  { id: 1, name: 'MILLIS', kind: 'struct', structDef: [] },
  { id: 2, name: 'MICROS', kind: 'struct', structDef: [] },
  { id: 3, name: 'NANOS', kind: 'struct', structDef: [] },
];

const logicalTypeDef: StructDef = [
  { id: 1, name: 'STRING', kind: 'struct', structDef: [] },
  { id: 2, name: 'MAP', kind: 'struct', structDef: [] },
  { id: 3, name: 'LIST', kind: 'struct', structDef: [] },
  { id: 4, name: 'ENUM', kind: 'struct', structDef: [] },
  {
    id: 5,
    name: 'DECIMAL',
    kind: 'struct',
    structDef: [
      { id: 1, name: 'scale', kind: 'i32' },
      { id: 2, name: 'precision', kind: 'i32' },
    ],
  },
  { id: 6, name: 'DATE', kind: 'struct', structDef: [] },
  {
    id: 7,
    name: 'TIME',
    kind: 'struct',
    structDef: [
      { id: 1, name: 'isAdjustedToUTC', kind: 'bool' },
      { id: 2, name: 'unit', kind: 'struct', structDef: timeUnitDef },
    ],
  },
  {
    id: 8,
    name: 'TIMESTAMP',
    kind: 'struct',
    structDef: [
      { id: 1, name: 'isAdjustedToUTC', kind: 'bool' },
      { id: 2, name: 'unit', kind: 'struct', structDef: timeUnitDef },
    ],
  },
  {
    id: 10,
    name: 'INTEGER',
    kind: 'struct',
    structDef: [
      { id: 1, name: 'bitWidth', kind: 'i8' },
      { id: 2, name: 'isSigned', kind: 'bool' },
    ],
  },
  { id: 11, name: 'UNKNOWN', kind: 'struct', structDef: [] },
  { id: 12, name: 'JSON', kind: 'struct', structDef: [] },
  { id: 13, name: 'BSON', kind: 'struct', structDef: [] },
  { id: 14, name: 'UUID', kind: 'struct', structDef: [] },
  { id: 15, name: 'FLOAT16', kind: 'struct', structDef: [] },
];

const schemaElementDef: StructDef = [
  { id: 1, name: 'type', kind: 'i32' },
  { id: 2, name: 'typeLength', kind: 'i32' },
  { id: 3, name: 'repetitionType', kind: 'i32' },
  { id: 4, name: 'name', kind: 'string' },
  { id: 5, name: 'numChildren', kind: 'i32' },
  { id: 6, name: 'convertedType', kind: 'i32' },
  { id: 7, name: 'scale', kind: 'i32' },
  { id: 8, name: 'precision', kind: 'i32' },
  { id: 9, name: 'fieldId', kind: 'i32' },
  { id: 10, name: 'logicalType', kind: 'struct', structDef: logicalTypeDef },
];

const sortingColumnDef: StructDef = [
  { id: 1, name: 'columnIdx', kind: 'i32' },
  { id: 2, name: 'descending', kind: 'bool' },
  { id: 3, name: 'nullsFirst', kind: 'bool' },
];

const pageEncodingStatsDef: StructDef = [
  { id: 1, name: 'pageType', kind: 'i32' },
  { id: 2, name: 'encoding', kind: 'i32' },
  { id: 3, name: 'count', kind: 'i32' },
];

const columnMetaDataDef: StructDef = [
  { id: 1, name: 'type', kind: 'i32' },
  { id: 2, name: 'encodings', kind: 'list', elemKind: 'i32' },
  { id: 3, name: 'pathInSchema', kind: 'list', elemKind: 'string' },
  { id: 4, name: 'codec', kind: 'i32' },
  { id: 5, name: 'numValues', kind: 'i64' },
  { id: 6, name: 'totalUncompressedSize', kind: 'i64' },
  { id: 7, name: 'totalCompressedSize', kind: 'i64' },
  { id: 8, name: 'keyValueMetadata', kind: 'list', elemKind: 'struct', elemStruct: keyValueDef },
  { id: 9, name: 'dataPageOffset', kind: 'i64' },
  { id: 10, name: 'indexPageOffset', kind: 'i64' },
  { id: 11, name: 'dictionaryPageOffset', kind: 'i64' },
  { id: 12, name: 'statistics', kind: 'struct', structDef: statisticsDef },
  {
    id: 13,
    name: 'encodingStats',
    kind: 'list',
    elemKind: 'struct',
    elemStruct: pageEncodingStatsDef,
  },
  { id: 14, name: 'bloomFilterOffset', kind: 'i64' },
  { id: 15, name: 'bloomFilterLength', kind: 'i32' },
  { id: 16, name: 'sizeStatistics', kind: 'struct', structDef: [] },
  { id: 17, name: 'geoStatistics', kind: 'struct', structDef: [] },
];

const columnChunkDef: StructDef = [
  { id: 1, name: 'filePath', kind: 'string' },
  { id: 2, name: 'fileOffset', kind: 'i64' },
  { id: 3, name: 'metaData', kind: 'struct', structDef: columnMetaDataDef },
  { id: 4, name: 'offsetIndexOffset', kind: 'i64' },
  { id: 5, name: 'offsetIndexLength', kind: 'i32' },
];

const rowGroupDef: StructDef = [
  { id: 1, name: 'columns', kind: 'list', elemKind: 'struct', elemStruct: columnChunkDef },
  { id: 2, name: 'totalByteSize', kind: 'i64' },
  { id: 3, name: 'numRows', kind: 'i64' },
  { id: 4, name: 'sortingColumns', kind: 'list', elemKind: 'struct', elemStruct: sortingColumnDef },
  { id: 5, name: 'fileOrdinal', kind: 'i16' },
  { id: 6, name: 'totalCompressedSize', kind: 'i64' },
  { id: 7, name: 'ordinal', kind: 'i16' },
];

const columnOrderDef: StructDef = [
  { id: 1, name: 'TYPE_ORDER', kind: 'struct', structDef: [] },
];

const dataPageHeaderDef: StructDef = [
  { id: 1, name: 'numValues', kind: 'i32' },
  { id: 2, name: 'encoding', kind: 'i32' },
  { id: 3, name: 'definitionLevelEncoding', kind: 'i32' },
  { id: 4, name: 'repetitionLevelEncoding', kind: 'i32' },
  { id: 5, name: 'statistics', kind: 'struct', structDef: statisticsDef },
];

const dataPageHeaderV2Def: StructDef = [
  { id: 1, name: 'numValues', kind: 'i32' },
  { id: 2, name: 'numNulls', kind: 'i32' },
  { id: 3, name: 'numRows', kind: 'i32' },
  { id: 4, name: 'encoding', kind: 'i32' },
  { id: 5, name: 'definitionLevelsByteLength', kind: 'i32' },
  { id: 6, name: 'repetitionLevelsByteLength', kind: 'i32' },
  { id: 7, name: 'isCompressed', kind: 'bool' },
  { id: 8, name: 'statistics', kind: 'struct', structDef: statisticsDef },
];

const dictionaryPageHeaderDef: StructDef = [
  { id: 1, name: 'numValues', kind: 'i32' },
  { id: 2, name: 'encoding', kind: 'i32' },
  { id: 3, name: 'isSorted', kind: 'bool' },
];

const pageHeaderDef: StructDef = [
  { id: 1, name: 'type', kind: 'i32' },
  { id: 2, name: 'uncompressedPageSize', kind: 'i32' },
  { id: 3, name: 'compressedPageSize', kind: 'i32' },
  { id: 4, name: 'crc', kind: 'i32' },
  { id: 5, name: 'dataPageHeader', kind: 'struct', structDef: dataPageHeaderDef },
  // NOTE: real-world writers (parquet-mr / pyarrow / Arrow C++) place the
  // dictionary header at field 7 and the v2 data header at field 8.
  { id: 7, name: 'dictionaryPageHeader', kind: 'struct', structDef: dictionaryPageHeaderDef },
  { id: 8, name: 'dataPageHeaderV2', kind: 'struct', structDef: dataPageHeaderV2Def },
];

const fileMetaDataDef: StructDef = [
  { id: 1, name: 'version', kind: 'i32' },
  { id: 2, name: 'schema', kind: 'list', elemKind: 'struct', elemStruct: schemaElementDef },
  { id: 3, name: 'numRows', kind: 'i64' },
  { id: 4, name: 'rowGroups', kind: 'list', elemKind: 'struct', elemStruct: rowGroupDef },
  { id: 5, name: 'keyValueMetadata', kind: 'list', elemKind: 'struct', elemStruct: keyValueDef },
  { id: 6, name: 'createdBy', kind: 'string' },
  { id: 7, name: 'columnOrders', kind: 'list', elemKind: 'struct', elemStruct: columnOrderDef },
  { id: 9, name: 'footerSigningKeyMetadata', kind: 'binary' },
  { id: 10, name: 'pageIndexOffset', kind: 'i64' },
];

/** Decode a Thrift Compact struct beginning at the reader's offset. */
export function decodeCompactStruct<T = Record<string, unknown>>(
  reader: ByteReader,
  def: StructDef,
): T {
  return readStruct(reader, def) as T;
}

export const THRIFT_DEFS = {
  fileMetaData: fileMetaDataDef,
  pageHeader: pageHeaderDef,
  dataPageHeader: dataPageHeaderDef,
  dataPageHeaderV2: dataPageHeaderV2Def,
  dictionaryPageHeader: dictionaryPageHeaderDef,
  statistics: statisticsDef,
  logicalType: logicalTypeDef,
  timeUnit: timeUnitDef,
};

