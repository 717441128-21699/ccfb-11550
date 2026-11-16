import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { ParquetFile } from '../../src/core/parquet.js';

const bytes = readFileSync('tests/data/36_list_of_struct.parquet');
const pf = await ParquetFile.open(new MemoryFile(bytes, 'x'));
const overview = await pf.readRowGroup(0);
for (const c of overview.columns) {
  console.log(c.leaf.name, '->', JSON.stringify(c.read.values.slice(0, 4)));
}
const rows = await pf.readRows(0);
console.log('row0:', JSON.stringify(rows[0]));

