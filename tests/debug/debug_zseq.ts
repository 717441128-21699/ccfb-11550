import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const bytes = readFileSync('tests/data/12_comprehensive.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const chunk = metadata.rowGroups[0].columns[1];
const meta = chunk.metaData!;
const { header } = await readPageHeader(file, Number(meta.dictionaryPageOffset));
const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
// frame: magic4 desc fcs(2) blockhdr3 => block at 10
const block = comp.subarray(10, 10 + (comp[7] | (comp[8] << 8) | (comp[9] << 16)));
console.log('block first 16:', [...block.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
// literal section first; find sequence header by decoding literals length
const tag = block[0];
const kind = tag & 3;
console.log('literal tag', tag.toString(16), 'kind', kind);

