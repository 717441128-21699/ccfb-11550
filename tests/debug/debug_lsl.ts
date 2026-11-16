import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';
import { buildField } from '../../src/core/assembler.js';

const bytes = readFileSync('tests/data/41_list_struct_list.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
const leaves = leafNodes(root);
for (let li = 0; li < leaves.length; li++) {
  const r = await readColumnChunk(file, metadata.rowGroups[0].columns[li], leaves[li]);
  const path: typeof leaves = [];
  let cur = root;
  for (const name of leaves[li].path.slice(1)) { cur = cur.children.find((c) => c.name === name)!; path.push(cur); }
  // row 0 slice
  let end = 1;
  while (end < r.repetitionLevels.length && r.repetitionLevels[end] !== 0) end++;
  const slice = { defs: r.definitionLevels.slice(0, end), reps: r.repetitionLevels.slice(0, end), values: r.values.slice(0, end) };
  console.log(leaves[li].name, 'row0 buildField:', JSON.stringify(buildField(path, slice)));
}

