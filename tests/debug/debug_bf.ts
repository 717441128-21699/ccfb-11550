import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';
import { buildField } from '../../src/core/assembler.js';

const bytes = readFileSync('tests/data/33_list_int.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
const leaves = leafNodes(root);
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[0], leaves[0]);
// row 3 slice (the [0,1,2,3,4] one)
const slice = {
  defs: r.definitionLevels.slice(3, 8),
  reps: r.repetitionLevels.slice(3, 8),
  values: r.values.slice(3, 8),
};
const path: typeof leaves = [];
let cur = root;
for (const name of leaves[0].path.slice(1)) {
  cur = cur.children.find((c) => c.name === name)!;
  path.push(cur);
}
console.log('buildField raw:', JSON.stringify(buildField(path, slice)));

