import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? '_snappy.parquet';
const bytes = readFileSync(join(here, 'data', target));
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
let offset = Number(meta.dataPageOffset);
const { header } = await readPageHeader(file, offset);
const compressed = await file.readAt(header.bodyOffset, header.compressedPageSize);
console.log('compressed', compressed.length, 'uncompressed', header.uncompressedPageSize);
const r = new ByteReader(compressed);
const declared = r.varint();
console.log('snappy declared uncompressed len:', declared);
let tags = 0;
let pos = r.offset;
while (pos < compressed.length && tags < 12) {
  const tag = compressed[pos++];
  const kind = tag & 3;
  if (kind === 0) {
    const six = tag >> 2;
    let litLen: number;
    let extra = 0;
    if (six < 60) litLen = six + 1;
    else { extra = six - 59; litLen = 1; for (let i = 0; i < extra; i++) litLen += compressed[pos++] << (8 * i); }
    console.log(`@${pos - 1} LITERAL len=${litLen} extraBytes=${extra}`);
    pos += litLen;
  } else if (kind === 1) {
    const len = 4 + (tag >> 2);
    const off = ((tag & 0xe0) << 3) | compressed[pos++];
    console.log(`@${pos - 2} COPY1 len=${len} offset=${off}`);
  } else if (kind === 2) {
    const len = 1 + (tag >> 2);
    const off = compressed[pos] | (compressed[pos + 1] << 8);
    pos += 2;
    console.log(`@${pos - 3} COPY2 len=${len} offset=${off}`);
  } else {
    const len = 1 + (tag >> 2);
    const off = compressed[pos] | (compressed[pos + 1] << 8) | (compressed[pos + 2] << 16) | (compressed[pos + 3] << 24);
    pos += 4;
    console.log(`@${pos - 5} COPY4 len=${len} offset=${off}`);
  }
  tags++;
}
console.log('walk ended at', pos, 'of', compressed.length);

