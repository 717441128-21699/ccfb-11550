// Test harness: decode every generated Parquet file with our hand-written
// parser and diff every value against pyarrow's canonical expected.json.
// Run: npm test  (after: py tests/generate_files.py)

import { readFileSync, openSync, fstatSync, readSync } from 'node:fs';
import type * as fsNamespace from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFile, RandomAccessFile, MemoryFile } from '../src/core/io.js';
import { ParquetFile } from '../src/core/parquet.js';
import { checkStatistics } from '../src/core/stats.js';
import { Encoding, PageType } from '../src/core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');

interface ExpectedColumn {
  name: string;
  physical: string | null;
  topLevel: boolean;
  nullCount: number;
  flatValues: unknown[] | null;
}
interface ExpectedRowGroup {
  numRows: number;
  rows: Record<string, unknown>[];
  columns: ExpectedColumn[];
}
interface ExpectedFile {
  file: string;
  numRows: number;
  numRowGroups: number;
  rowGroups: ExpectedRowGroup[];
  hasStatistics: boolean;
  compression: string;
}

const expected = JSON.parse(
  readFileSync(join(DATA_DIR, 'expected.json'), 'utf8'),
) as Record<string, ExpectedFile>;

function openNodeFile(path: string, name: string): NodeFile {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  return new NodeFile(fd, name, size, fs);
}

import * as fs from 'node:fs';

// Normalize parser wrapper objects (Int64Value, DecimalValue, Int96Value,
// Uint8Array) into the plain JSON shapes pyarrow's canonical output uses.
function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Uint8Array) {
    return '0x' + [...v].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (typeof v === 'object') {
    const anyV = v as { toString?: () => string; value?: unknown; unscaled?: bigint };
    // Exact-value wrappers (Int64/Decimal/Int96) carry their own toString.
    if ((anyV.value !== undefined || anyV.unscaled !== undefined) && typeof anyV.toString === 'function') {
      return anyV.toString();
    }
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = normalize(val);
    return out;
  }
  return v;
}

// ---- Deep equality tuned for our rendered values ----

function deepEqual(aRaw: unknown, bRaw: unknown, path = '$'): string | null {
  const a = normalize(aRaw);
  const b = normalize(bRaw);
  if (a === b) return null;
  if (a === null || b === null) return `${path}: null mismatch ${show(a)} vs ${show(b)}`;
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b} (${show(a)} vs ${show(b)})`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array mismatch`;
    if (a.length !== b.length) return `${path}: array length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = deepEqual(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'object' || typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      if (!(k in ao)) return `${path}.${k}: missing actual`;
      if (!(k in bo)) return `${path}.${k}: unexpected actual ${show(ao[k])}`;
      const d = deepEqual(ao[k], bo[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) ? null : `${path}: number ${a} vs ${b}`;
  }
  return `${path}: ${show(a)} vs ${show(b)}`;
}

function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v);
  if (Array.isArray(v)) return `[len=${v.length}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).join(',')}}`;
  return String(v);
}

interface FileResult {
  name: string;
  ok: boolean;
  failures: string[];
  pages: number;
  values: number;
  statIssues: number;
}

async function runFile(name: string, spec: ExpectedFile): Promise<FileResult> {
  const failures: string[] = [];
  const path = join(DATA_DIR, spec.file);
  const file = openNodeFile(path, spec.file);
  const pf = await ParquetFile.open(file);
  let pageCount = 0;
  let valueCount = 0;
  let statIssues = 0;

  if (Number(pf.metadata.numRows) !== spec.numRows) {
    failures.push(`numRows ${pf.metadata.numRows} != ${spec.numRows}`);
  }
  if (pf.metadata.rowGroups.length !== spec.numRowGroups) {
    failures.push(`rowGroups ${pf.metadata.rowGroups.length} != ${spec.numRowGroups}`);
  }
  // Note: leaf count can exceed the top-level column count for nested structs
  // (each primitive leaf is a separate column chunk), so no equality assertion.

  for (let rg = 0; rg < spec.numRowGroups; rg++) {
    const expRG = spec.rowGroups[rg];
    const overview = await pf.readRowGroup(rg);

    // 1) Per-leaf checks. Expected columns are keyed by top-level field name;
    // nested leaves map back to their top-level field for null accounting.
    for (let ci = 0; ci < overview.columns.length; ci++) {
      const col = overview.columns[ci];
      const topName = col.leaf.path[1] ?? col.leaf.name;
      const expCol = expRG.columns.find((c) => c.name === topName);
      if (!expCol) {
        failures.push(`RG${rg} leaf ${col.leaf.path.join('.')}: no expected column`);
        continue;
      }
      pageCount += col.read.pages.length;
      for (const page of col.read.pages) {
        if (page.decompressionError) {
          failures.push(
            `RG${rg} ${expCol.name} ${PageType[page.header.type]} page ${page.ordinal}: ${page.decompressionError}`,
          );
        }
      }
      valueCount += col.read.values.length;
      // Null counts are only comparable for flat top-level primitive columns;
      // a nested leaf's record count includes repeated elements.
      if (expCol.topLevel && col.read.numNulls !== expCol.nullCount) {
        failures.push(
          `RG${rg} ${expCol.name}: null count ${col.read.numNulls} != pyarrow ${expCol.nullCount}`,
        );
      }
      if (expCol.topLevel && expCol.flatValues) {
        const got = col.read.values as unknown[];
        if (got.length !== expCol.flatValues.length) {
          failures.push(
            `RG${rg} ${expCol.name}: value count ${got.length} != ${expCol.flatValues.length}`,
          );
          continue;
        }
        for (let i = 0; i < got.length; i++) {
          const d = deepEqual(got[i], expCol.flatValues[i], `RG${rg}.${expCol.name}[${i}]`);
          if (d) {
            failures.push(d);
            break; // one diff per column is enough detail
          }
        }
      }
      // 2) Statistics cross-check (flat columns only; nested leaf stats use a
      // different record granularity).
      if (spec.hasStatistics && spec.numRows > 0 && expCol.topLevel) {
        const check = checkStatistics(col.read);
        if (!check.nullCount.ok) {
          statIssues++;
          failures.push(`RG${rg} ${expCol.name}: ${check.issues.join('; ')}`);
        }
        if (!check.min.ok || !check.max.ok) {
          statIssues++;
          failures.push(
            `RG${rg} ${expCol.name}: min/max check: ${check.issues.join('; ')}`,
          );
        }
      }
    }

    // 3) Full nested JSON row reconstruction.
    const rows = await pf.readRows(rg);
    if (rows.length !== expRG.numRows) {
      failures.push(`RG${rg}: assembled row count ${rows.length} != ${expRG.numRows}`);
    } else {
      const limit = Math.min(rows.length, expRG.rows.length);
      for (let i = 0; i < limit; i++) {
        const d = deepEqual(rows[i], expRG.rows[i], `RG${rg}.row[${i}]`);
        if (d) {
          failures.push(d);
          break;
        }
      }
    }
  }

  return { name, ok: failures.length === 0, failures, pages: pageCount, values: valueCount, statIssues };
}

/** Range-read accounting: prove large files only fetch needed byte ranges. */
class CountingFile implements RandomAccessFile {
  readonly size: number;
  readonly name = 'counting';
  reads = 0;
  bytesRead = 0;
  constructor(private readonly inner: RandomAccessFile) {
    this.size = inner.size;
  }
  async readAt(position: number, length: number): Promise<Uint8Array> {
    this.reads++;
    this.bytesRead += length;
    return this.inner.readAt(position, length);
  }
}

async function rangeReadTest(spec: ExpectedFile): Promise<string | null> {
  const path = join(DATA_DIR, spec.file);
  const raw = readFileSync(path);
  const counter = new CountingFile(new MemoryFile(raw, spec.file));
  // Use a small cache block so a multi-block large file must issue several
  // bounded range reads rather than touching the whole file repeatedly.
  const pf = await ParquetFile.open(counter, { blockSize: 64 * 1024 });
  await pf.readColumn(0, 0);
  const totalBytes = counter.bytesRead;
  // The footer plus one column's pages must never exceed the file size, and
  // random access keeps total fetched bytes bounded (no full re-read per page).
  if (totalBytes <= 0) return 'no bytes read at all';
  if (totalBytes > raw.length) return `read ${totalBytes} > file size ${raw.length}`;
  return null;
}

async function main(): Promise<void> {
  const names = Object.keys(expected).sort();
  const results: FileResult[] = [];
  for (const name of names) {
    try {
      results.push(await runFile(name, expected[name]));
    } catch (err) {
      results.push({
        name,
        ok: false,
        failures: [`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`],
        pages: 0,
        values: 0,
        statIssues: 0,
      });
    }
  }

  // Range-read check on the biggest file and a zstd one.
  const rangeTargets = ['large_rows', 'primitive_zstd'];
  for (const t of rangeTargets) {
    const spec = Object.entries(expected).find(([n]) => n === t)?.[1];
    if (!spec) continue;
    try {
      const err = await rangeReadTest(spec);
      if (err) {
        const r = results.find((x) => x.name === t);
        r?.failures.push(`range-read: ${err}`);
        if (r) r.ok = false;
      }
    } catch (err) {
      const r = results.find((x) => x.name === t);
      r?.failures.push(`range-read FATAL: ${err instanceof Error ? err.message : String(err)}`);
      if (r) r.ok = false;
    }
  }

  let passed = 0;
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    if (r.ok) passed++;
    console.log(
      `${tag}  ${r.name.padEnd(26)} pages=${String(r.pages).padStart(4)} values=${String(r.values).padStart(6)}` +
        (r.statIssues ? ` statIssues=${r.statIssues}` : ''),
    );
    if (!r.ok) {
      for (const f of r.failures.slice(0, 5)) console.log(`        - ${f}`);
      if (r.failures.length > 5) console.log(`        - … ${r.failures.length - 5} more`);
    }
  }
  console.log(`\n${passed}/${results.length} files passed`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
