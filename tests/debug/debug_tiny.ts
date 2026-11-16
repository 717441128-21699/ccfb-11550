import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressPage } from '../../src/core/codecs.js';
import { CompressionCodec } from '../../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? '_tiny.parquet';
const bytes = readFileSync(join(here, 'data', target));
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const chunk = metadata.rowGroups[0].columns[0];
const meta = chunk.metaData!;
console.log('codec', CompressionCodec[meta.codec]);

let offset = Number(meta.dataPageOffset);
const { header } = await readPageHeader(file, offset);
const compressed = await file.readAt(header.bodyOffset, header.compressedPageSize);
const body = await decompressPage(compressed, {
  codec: meta.codec, pageLabel: 'debug', uncompressedSize: header.uncompressedPageSize,
});
console.log('body', body.length, 'bytes:', [...body].map((b) => b.toString(16).padStart(2, '0')).join(' '));
const r = new ByteReader(body);
const defLen = r.u32();
console.log('def length prefix =', defLen);
const stream = body.slice(4, 4 + defLen);
console.log('def stream hex:', [...stream].map((b) => b.toString(16).padStart(2, '0')).join(' '));

// manual varint walk
let p = 0;
while (p < stream.length) {
  let hdr = 0, shift = 0;
  const start = p;
  for (;;) { const b = stream[p++]; hdr |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  if ((hdr & 1) === 0) {
    const groups = hdr >>> 1;
    const cnt = groups * 8;
    const cost = Math.ceil(cnt / 8);
    console.log(`@${start} BITPACK hdr=${hdr} groups=${groups} values=${cnt} cost=${cost} data=${[...stream.slice(p, p + cost)].map((b) => b.toString(16)).join(' ')}`);
    p += cost;
  } else {
    const cnt = hdr >>> 1;
    console.log(`@${start} RLE hdr=${hdr} count=${cnt} value=${stream[p++]}`);
  }
}

