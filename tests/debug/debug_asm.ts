import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';
import { assembleJsonRows } from '../../src/core/assembler.js';

const bytes = readFileSync('tests/data/33_list_int.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
const leaves = leafNodes(root);
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[0], leaves[0]);
const rows = assembleJsonRows(root, [r], Number(metadata.numRows));
console.log(JSON.stringify(rows.slice(0, 6)));
console.log('firstRepeated path check:');
for (const n of leaves[0].path) {
  const node = (function find(s: typeof root): typeof root | undefined {
    const walk = (x: typeof root): typeof root | undefined => {
      if (x.name === n) return x;
      for (const c of x.children) { const f = walk(c); if (f) return f; }
    };
    return walk(s);
  })(root);
  console.log(' ', n, node?.repetition);
}
// Inspect a non-empty row's slice directly.
let start = 0;
const slices: { defs: number[]; reps: number[] }[] = [];
for (let i = 1; i <= r.repetitionLevels.length; i++) {
  if (i === r.repetitionLevels.length || r.repetitionLevels[i] === 0) {
    slices.push({ defs: r.definitionLevels.slice(start, i), reps: r.repetitionLevels.slice(start, i) });
    start = i;
  }
}
console.log('row1 slice (should be [0]):', JSON.stringify(slices[1]));
console.log('row3 slice (should be [0..4]):', JSON.stringify(slices[3]));
console.log('path:', leaves[0].path.join(' / '));
console.log('defs:', r.definitionLevels.slice(0, 12).join(','));
console.log('reps:', r.repetitionLevels.slice(0, 12).join(','));
console.log('values sample:', r.values.slice(0, 8).map(String).join(','));

