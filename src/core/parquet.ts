// Top-level Parquet inspection API used by both the browser UI and the
// Node test harness. All parsing is local; the only async boundary is the
// random-access byte source.

import { CachedFile, RandomAccessFile } from './io.js';
import { buildSchemaTree, leafNodes, readFooter, FooterResult } from './metadata.js';
import { readColumnChunk, ColumnReadResult, PageInfo } from './column.js';
import { checkStatistics, StatCheck } from './stats.js';
import { assembleJsonRows, JsonValue } from './assembler.js';
import {
  ColumnChunk,
  CompressionCodec,
  Encoding,
  FileMetaData,
  RowGroup,
  SchemaNode,
  Type,
} from './types.js';

export interface InspectorOptions {
  blockSize?: number;
  maxCachedBytes?: number;
}

export interface ColumnOverview {
  leaf: SchemaNode;
  chunk: ColumnChunk;
  read: ColumnReadResult;
  statCheck: StatCheck;
}

export interface RowGroupOverview {
  rowGroup: RowGroup;
  ordinal: number;
  columns: ColumnOverview[];
}

export class ParquetFile {
  readonly cached: CachedFile;
  footer!: FooterResult;
  metadata!: FileMetaData;
  schemaRoot!: SchemaNode;
  leaves!: SchemaNode[];

  private constructor(file: RandomAccessFile, opts: InspectorOptions) {
    this.cached = new CachedFile(file, opts.blockSize, opts.maxCachedBytes);
  }

  static async open(file: RandomAccessFile, opts: InspectorOptions = {}): Promise<ParquetFile> {
    const pf = new ParquetFile(file, opts);
    // Footer read is the only eager I/O: tail + metadata bytes only.
    pf.footer = await readFooter(pf.cached);
    pf.metadata = pf.footer.metadata;
    pf.schemaRoot = buildSchemaTree(pf.metadata.schema);
    pf.leaves = leafNodes(pf.schemaRoot);
    return pf;
  }

  get name(): string {
    return this.cached.name;
  }

  get size(): number {
    return this.cached.size;
  }

  get footerRange(): { offset: number; length: number } {
    return { offset: this.footer.footerOffset, length: this.footer.footerLength };
  }

  get cacheStats(): { blocks: number; cachedBytes: number } {
    return this.cached.cacheStats;
  }

  /** Distinct encodings/codecs actually referenced, for the overview panel. */
  collectEncodings(): { encodings: Set<Encoding>; codecs: Set<CompressionCodec>; types: Set<Type> } {
    const encodings = new Set<Encoding>();
    const codecs = new Set<CompressionCodec>();
    const types = new Set<Type>();
    for (const rg of this.metadata.rowGroups) {
      for (const cc of rg.columns) {
        if (cc.metaData) {
          cc.metaData.encodings.forEach((e) => encodings.add(e));
          codecs.add(cc.metaData.codec);
          types.add(cc.metaData.type);
        }
      }
    }
    return { encodings, codecs, types };
  }

  /** Read one leaf column within one row group (on-demand, range-based). */
  async readColumn(
    rowGroupOrdinal: number,
    leafOrdinal: number,
  ): Promise<ColumnReadResult> {
    const rg = this.metadata.rowGroups[rowGroupOrdinal];
    if (!rg) throw new Error(`row group ${rowGroupOrdinal} does not exist`);
    const chunk = rg.columns[leafOrdinal];
    if (!chunk) throw new Error(`column ${leafOrdinal} does not exist`);
    const node = this.leaves[leafOrdinal];
    return readColumnChunk(this.cached, chunk, node);
  }

  /** Read every leaf column of a row group. */
  async readRowGroup(rowGroupOrdinal: number): Promise<RowGroupOverview> {
    const rg = this.metadata.rowGroups[rowGroupOrdinal];
    if (!rg) throw new Error(`row group ${rowGroupOrdinal} does not exist`);
    const columns: ColumnOverview[] = [];
    for (let i = 0; i < rg.columns.length; i++) {
      const read = await this.readColumn(rowGroupOrdinal, i);
      columns.push({
        leaf: this.leaves[i],
        chunk: rg.columns[i],
        read,
        statCheck: checkStatistics(read),
      });
    }
    return { rowGroup: rg, ordinal: rowGroupOrdinal, columns };
  }

  /** Read only page/level metadata of a column (no value decoding). */
  async readColumnMetadata(rowGroupOrdinal: number, leafOrdinal: number): Promise<PageInfo[]> {
    const rg = this.metadata.rowGroups[rowGroupOrdinal];
    const chunk = rg.columns[leafOrdinal];
    const node = this.leaves[leafOrdinal];
    const result = await readColumnChunk(this.cached, chunk, node, { metadataOnly: true });
    return result.pages;
  }

  /** Full materialization of a row group as JSON rows (nested structure). */
  async readRows(rowGroupOrdinal: number): Promise<JsonValue[]> {
    const overview = await this.readRowGroup(rowGroupOrdinal);
    const reads = overview.columns.map((c) => c.read);
    const rowCount = Number(this.metadata.rowGroups[rowGroupOrdinal].numRows);
    return assembleJsonRows(this.schemaRoot, reads, rowCount);
  }
}

export type { PageInfo };
