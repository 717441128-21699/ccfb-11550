import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';

const { metadata } = await readFooter(new MemoryFile(readFileSync('tests/data/41_list_struct_list.parquet'), 'x'));
const root = buildSchemaTree(metadata.schema);
function walk(n: typeof root, d: number): void {
  console.log('  '.repeat(d) + `${n.name} rep=${n.repetition} logical=${n.logicalType?.type ?? '-'} conv=${n.convertedType ?? '-'}`);
  n.children.forEach((c) => walk(c, d + 1));
}
walk(root, 0);
void leafNodes;

