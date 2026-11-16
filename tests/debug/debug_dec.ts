import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';

const bytes = readFileSync('tests/data/14_decimals_int32.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const leaves = leafNodes(buildSchemaTree(metadata.schema));
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[0], leaves[0]);
const all = r.physicalValues;
console.log('sample physical types:', all.slice(0, 4).map((v) => v === null ? 'null' : typeof v + ':' + String((v as { constructor: { name: string } }).constructor.name)));
const vals = all.filter((v) => v !== null) as unknown[];
let mx = -Infinity;
let mn = Infinity;
for (const v of vals) {
  const n = typeof v === 'number' ? v
    : typeof v === 'bigint' ? Number(v)
    : Number((v as { value?: bigint; unscaled?: bigint }).value ?? (v as { unscaled?: bigint }).unscaled);
  if (Number.isNaN(n)) { console.log('NaN from', v); continue; }
  if (n > mx) mx = n;
  if (n < mn) mn = n;
}
console.log('count', vals.length, 'physical min', mn, 'max', mx);

