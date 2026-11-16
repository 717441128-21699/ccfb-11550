// Parquet on-wire enums and the decoded metadata model (parquet.thrift).

// ---- Enums (values from parquet.thrift) ----

export enum Type {
  BOOLEAN = 0,
  INT32 = 1,
  INT64 = 2,
  INT96 = 3,
  FLOAT = 4,
  DOUBLE = 5,
  BYTE_ARRAY = 6,
  FIXED_LEN_BYTE_ARRAY = 7,
}

export enum ConvertedType {
  UTF8 = 0,
  MAP = 1,
  MAP_KEY_VALUE = 2,
  LIST = 3,
  ENUM = 4,
  DECIMAL = 5,
  DATE = 6,
  TIME_MILLIS = 7,
  TIME_MICROS = 8,
  TIMESTAMP_MILLIS = 9,
  TIMESTAMP_MICROS = 10,
  UINT_8 = 11,
  UINT_16 = 12,
  UINT_32 = 13,
  UINT_64 = 14,
  INT_8 = 15,
  INT_16 = 16,
  INT_32 = 17,
  INT_64 = 18,
  JSON = 19,
  BSON = 20,
  INTERVAL = 21,
  NA = 22,
  FLOAT16 = 23,
}

export enum FieldRepetitionType {
  REQUIRED = 0,
  OPTIONAL = 1,
  REPEATED = 2,
}

export enum Encoding {
  PLAIN = 0,
  PLAIN_DICTIONARY = 2,
  RLE = 3,
  BIT_PACKED = 4,
  DELTA_BINARY_PACKED = 5,
  DELTA_LENGTH_BYTE_ARRAY = 6,
  DELTA_BYTE_ARRAY = 7,
  RLE_DICTIONARY = 8,
  BYTE_STREAM_SPLIT = 9,
}

export enum CompressionCodec {
  UNCOMPRESSED = 0,
  SNAPPY = 1,
  GZIP = 2,
  LZO = 3,
  BROTLI = 4,
  LZ4 = 5,
  ZSTD = 6,
  LZ4_RAW = 7,
}

export enum PageType {
  DATA_PAGE = 0,
  INDEX_PAGE = 1,
  DICTIONARY_PAGE = 2,
  DATA_PAGE_V2 = 3,
}

// ---- Logical types (union in parquet.thrift) ----

export interface LogicalTypeBase {
  type: string;
}
export interface StringLogicalType extends LogicalTypeBase {
  type: 'STRING';
}
export interface MapLogicalType extends LogicalTypeBase {
  type: 'MAP';
}
export interface ListLogicalType extends LogicalTypeBase {
  type: 'LIST';
}
export interface EnumLogicalType extends LogicalTypeBase {
  type: 'ENUM';
}
export interface DecimalLogicalType extends LogicalTypeBase {
  type: 'DECIMAL';
  precision: number;
  scale: number;
}
export interface DateLogicalType extends LogicalTypeBase {
  type: 'DATE';
}
export interface TimeLogicalType extends LogicalTypeBase {
  type: 'TIME';
  isAdjustedToUTC: boolean;
  unit: TimeUnit;
}
export interface TimestampLogicalType extends LogicalTypeBase {
  type: 'TIMESTAMP';
  isAdjustedToUTC: boolean;
  unit: TimeUnit;
}
export interface IntegerLogicalType extends LogicalTypeBase {
  type: 'INTEGER';
  bitWidth: 8 | 16 | 32 | 64;
  isSigned: boolean;
}
export interface JsonLogicalType extends LogicalTypeBase {
  type: 'JSON';
}
export interface BsonLogicalType extends LogicalTypeBase {
  type: 'BSON';
}
export interface UUIDLogicalType extends LogicalTypeBase {
  type: 'UUID';
}
export interface Float16LogicalType extends LogicalTypeBase {
  type: 'FLOAT16';
}
export interface NullLogicalType extends LogicalTypeBase {
  type: 'UNKNOWN';
}

export type LogicalType =
  | StringLogicalType
  | MapLogicalType
  | ListLogicalType
  | EnumLogicalType
  | DecimalLogicalType
  | DateLogicalType
  | TimeLogicalType
  | TimestampLogicalType
  | IntegerLogicalType
  | JsonLogicalType
  | BsonLogicalType
  | UUIDLogicalType
  | Float16LogicalType
  | NullLogicalType;

export type TimeUnit =
  | { kind: 'MILLIS' }
  | { kind: 'MICROS' }
  | { kind: 'NANOS' };

// ---- Thrift metadata structures (only fields we decode) ----

export interface SchemaElement {
  type?: Type;
  typeLength?: number;
  repetitionType?: FieldRepetitionType;
  name: string;
  numChildren?: number;
  convertedType?: ConvertedType;
  scale?: number;
  precision?: number;
  fieldId?: number;
  logicalType?: LogicalType;
}

export interface Statistics {
  max?: Uint8Array;
  min?: Uint8Array;
  nullCount?: bigint;
  distinctCount?: bigint;
  maxValue?: Uint8Array;
  minValue?: Uint8Array;
}

export interface KeyValue {
  key: string;
  value?: string;
}

export interface DataPageHeader {
  numValues: number;
  encoding: Encoding;
  definitionLevelEncoding: Encoding;
  repetitionLevelEncoding: Encoding;
  statistics?: Statistics;
}

export interface DataPageHeaderV2 {
  numValues: number;
  numNulls: number;
  numRows: number;
  encoding: Encoding;
  definitionLevelsByteLength: number;
  repetitionLevelsByteLength: number;
  isCompressed?: boolean;
  statistics?: Statistics;
}

export interface DictionaryPageHeader {
  numValues: number;
  encoding: Encoding;
}

export interface PageHeader {
  type: PageType;
  uncompressedPageSize: number;
  compressedPageSize: number;
  crc?: number;
  dataPageHeader?: DataPageHeader;
  dataPageHeaderV2?: DataPageHeaderV2;
  dictionaryPageHeader?: DictionaryPageHeader;
  /** Absolute byte offset of this page header in the file. */
  headerOffset: number;
  /** Absolute byte offset of the page body in the file. */
  bodyOffset: number;
}

export interface ColumnMetaData {
  type: Type;
  encodings: Encoding[];
  pathInSchema: string[];
  codec: CompressionCodec;
  numValues: bigint;
  totalUncompressedSize: bigint;
  totalCompressedSize: bigint;
  keyValueMetadata?: KeyValue[];
  dataPageOffset: bigint;
  indexPageOffset?: bigint;
  dictionaryPageOffset?: bigint;
  statistics?: Statistics;
  /** Summed by us while reading pages, for cross-checks. */
  encodingStats?: { encoding: Encoding; count: number }[];
}

export interface ColumnChunk {
  filePath?: string;
  fileOffset: bigint;
  metaData?: ColumnMetaData;
  /** Populated when only an offset is stored (encryption/rare cases). */
  offsetIndexOffset?: bigint;
  offsetIndexLength?: number;
}

export interface RowGroup {
  columns: ColumnChunk[];
  totalByteSize: bigint;
  numRows: bigint;
  sortingColumns?: unknown[];
  fileOrdinal?: number;
  totalCompressedSize?: bigint;
  ordinal?: number;
}

export interface SortingColumn {
  columnIdx: number;
  descending: boolean;
  nullsFirst: boolean;
}

export interface FileMetaData {
  version: number;
  schema: SchemaElement[];
  numRows: bigint;
  rowGroups: RowGroup[];
  keyValueMetadata: KeyValue[];
  createdBy?: string;
  columnOrders?: { type: 'TYPE_ORDER' | 'UNKNOWN' }[];
  encryptionAlgorithm?: unknown;
  footerSigningKeyMetadata?: Uint8Array;
}

// ---- Decoded schema tree (our own model) ----

export interface SchemaNode {
  /** Index into the flat FileMetaData.schema array. */
  schemaIndex: number;
  name: string;
  repetition?: FieldRepetitionType;
  physicalType?: Type;
  typeLength?: number;
  convertedType?: ConvertedType;
  logicalType?: LogicalType;
  scale?: number;
  precision?: number;
  fieldId?: number;
  children: SchemaNode[];
  /** Path from root, e.g. ['my_list', 'list', 'element']. */
  path: string[];
  /** Max definition level for this node (computed). */
  maxDefinitionLevel: number;
  /** Max repetition level for this node (computed). */
  maxRepetitionLevel: number;
  /**
   * Definition level at which the top-level field itself becomes present.
   * Records strictly below this level are null; records at/above are present
   * (e.g. an empty list still counts as a present, non-null field).
   */
  nullDefinitionLevel: number;
}

export const PARQUET_MAGIC = 'PAR1';
export const EMPTY_SET = 0;
export const LEADING_DICT_PAGE_ENCODINGS = new Set([
  Encoding.PLAIN_DICTIONARY,
  Encoding.RLE_DICTIONARY,
]);
