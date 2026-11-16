import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';

const target = process.argv[2] ?? '13_int_widths.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
const leaves = leafNodes(root);
for (let ci = 0; ci < leaves.length; ci++) {
  try {
    const r = await readColumnChunk(file, metadata.rowGroups[0].columns[ci], leaves[ci]);
    console.log(`col ${ci} ${leaves[ci].name}: OK values=${r.values.length} nulls=${r.numNulls} sample=${JSON.stringify(r.values.slice(0, 5))}`);
  } catch (e) {
    console.log(`col ${ci} ${leaves[ci].name}: FAIL`, e instanceof Error ? e.message : String(e));
  }
}

