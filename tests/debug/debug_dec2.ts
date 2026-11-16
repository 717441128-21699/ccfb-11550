import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';
import { bigIntFromTwosComplement } from '../../src/core/value.js';

const bytes = readFileSync('tests/data/14_decimals_int32.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const leaves = leafNodes(buildSchemaTree(metadata.schema));
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[0], leaves[0]);
const vals = r.physicalValues.filter((v) => v !== null) as Uint8Array[];
const nums = vals.map((v) => bigIntFromTwosComplement(v));
let mx = nums[0], mn = nums[0];
for (const n of nums) { if (n > mx) mx = n; if (n < mn) mn = n; }
console.log('actual unscaled min', mn.toString(), 'max', mx.toString(), '=> decimal', (mx / 100n).toString());
const st = metadata.rowGroups[0].columns[0].metaData!.statistics!;
console.log('stat maxValue bytes', [...(st.maxValue ?? new Uint8Array())].map((b) => b.toString(16)).join(' '));
console.log('stat max unscaled', bigIntFromTwosComplement(st.maxValue!).toString());

