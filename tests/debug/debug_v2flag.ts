import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const f = new MemoryFile(readFileSync('tests/data/23_bool_v2.parquet'), 'x');
const m = await readFooter(f);
const off = Number(m.metadata.rowGroups[0].columns[0].metaData!.dataPageOffset);
const h = (await readPageHeader(f, off)).dataPageHeaderV2;
console.log(JSON.stringify(h));

