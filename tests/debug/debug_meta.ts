import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter } from '../../src/core/metadata.js';

const bytes = readFileSync('tests/data/12_comprehensive.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
for (let ci = 0; ci < 3; ci++) {
  const m = metadata.rowGroups[0].columns[ci].metaData!;
  console.log(ci, m.pathInSchema.join('.'), 'dataOff', m.dataPageOffset.toString(), 'dictOff', m.dictionaryPageOffset?.toString());
}

