import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { FieldRepetitionType } from '../../src/core/types.js';

const m = await readFooter(new MemoryFile(readFileSync('tests/data/33_list_int.parquet'), 'x'));
const root = buildSchemaTree(m.metadata.schema);
const leaf = leafNodes(root)[0];
let cur = root;
for (const name of leaf.path.slice(1)) {
  cur = cur.children.find((c) => c.name === name)!;
  console.log(name, 'rep=', cur.repetition, 'REPEATED enum=', FieldRepetitionType.REPEATED, 'match=', cur.repetition === FieldRepetitionType.REPEATED);
}

