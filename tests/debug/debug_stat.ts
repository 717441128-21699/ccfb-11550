import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';
import { checkStatistics } from '../../src/core/stats.js';

const target = process.argv[2] ?? '13_int_widths.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
const leaves = leafNodes(root);
const ci = Number(process.argv[3] ?? 0);
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[ci], leaves[ci]);
const nums = r.physicalValues.filter((v) => v !== null) as number[];
const mn = Math.min(...nums);
const mx = Math.max(...nums);
console.log('col', leaves[ci].name, 'count', nums.length, 'myMin', mn, 'myMax', mx);
const st = metadata.rowGroups[0].columns[ci].metaData!.statistics!;
console.log('stat bytes min', [...(st.minValue ?? st.min ?? new Uint8Array())].map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('check:', JSON.stringify(checkStatistics(r), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1).slice(0, 600));

