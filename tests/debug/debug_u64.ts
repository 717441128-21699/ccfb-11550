import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';
import { valueToText } from '../../src/core/value.js';

const bytes = readFileSync('tests/data/00_primitive_plain.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const leaves = leafNodes(buildSchemaTree(metadata.schema));
const u64 = leaves.find((n) => n.name === 'u64')!;
console.log('u64 logicalType', JSON.stringify(u64.logicalType), 'converted', u64.convertedType);
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[leaves.indexOf(u64)], u64);
console.log('first 5 logical:', r.values.slice(0, 5).map((v) => valueToText(v)).join(','));
console.log('first 5 physical:', r.physicalValues.slice(0, 5).map((v) => valueToText(v)).join(','));

