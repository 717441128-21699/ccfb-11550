import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressZstd } from '../../src/core/zstd.js';

const bytes = readFileSync('tests/data/12_comprehensive.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const chunk = metadata.rowGroups[0].columns[1];
const meta = chunk.metaData!;
const { header } = await readPageHeader(file, Number(meta.dictionaryPageOffset));
const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
// frame: magic(4) desc(1) fcs(?) then block header(3) then block
console.log('frame head:', [...comp.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
const desc = comp[4];
console.log('descriptor', desc.toString(16), 'singleSegment', (desc & 0x20) !== 0, 'fcsFlag', desc >>> 6);
// singleSegment fcsFlag=1 -> 2 byte FCS; block header at 7
const bh = comp[7] | (comp[8] << 8) | (comp[9] << 16);
console.log('block hdr', bh, 'type', (bh >> 1) & 3, 'size', bh >>> 3);
const block = comp.subarray(10, 10 + (bh >>> 3));
console.log('block first 20:', [...block.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

