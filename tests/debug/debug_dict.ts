import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { readColumnChunk } from '../../src/core/column.js';

const target = process.argv[2] ?? '13_int_widths.parquet';
const ci = Number(process.argv[3] ?? 0);
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const root = buildSchemaTree(metadata.schema);
const leaves = leafNodes(root);
const r = await readColumnChunk(file, metadata.rowGroups[0].columns[ci], leaves[ci]);
console.log('first 15 decoded:', r.values.slice(0, 15).join(','));
console.log('num pages', r.pages.length, 'page types', r.pages.map((p) => p.header.type).join(','));

