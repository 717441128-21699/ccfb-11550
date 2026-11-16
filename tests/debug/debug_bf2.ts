import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';
import { buildField } from '../../src/core/assembler.js';

const bytes = readFileSync('tests/data/36_list_of_struct.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
const leaves = leafNodes(root);
for (let li = 0; li < leaves.length; li++) {
  const r = await readColumnChunk(file, metadata.rowGroups[0].columns[li], leaves[li]);
  const path: typeof leaves = [];
  let cur = root;
  for (const name of leaves[li].path.slice(1)) { cur = cur.children.find((c) => c.name === name)!; path.push(cur); }
  const slice = { defs: r.definitionLevels.slice(0, 3), reps: r.repetitionLevels.slice(0, 3), values: r.values.slice(0, 3) };
  console.log(leaves[li].name, 'buildField:', JSON.stringify(buildField(path, slice)));
}

