import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';

const target = process.argv[2] ?? '33_list_int.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
function dump(node: typeof root, depth: number): void {
  console.log('  '.repeat(depth) + `${node.name} rep=${node.repetition} DL=${node.maxDefinitionLevel} RL=${node.maxRepetitionLevel} nullDL=${node.nullDefinitionLevel}${node.physicalType !== undefined ? ' phys=' + node.physicalType : ''}`);
  node.children.forEach((c) => dump(c, depth + 1));
}
dump(root, 0);
const leaves = leafNodes(root);
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[0], leaves[0]);
console.log('leaf maxDL', leaves[0].maxDefinitionLevel, 'maxRL', leaves[0].maxRepetitionLevel);
console.log('first 20 defs', r.definitionLevels.slice(0, 20).join(','));
console.log('first 20 reps', r.repetitionLevels.slice(0, 20).join(','));
console.log('my numNulls', r.numNulls);

