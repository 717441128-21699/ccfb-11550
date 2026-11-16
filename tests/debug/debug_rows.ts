import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { ParquetFile } from '../../src/core/parquet.js';

const target = process.argv[2] ?? '33_list_int.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const pf = await ParquetFile.open(new MemoryFile(bytes, target));
const rows = await pf.readRows(0);
console.log('mine first6:', JSON.stringify(rows.slice(0, 6)));

