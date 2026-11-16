import { readFileSync } from 'node:fs';
import { ByteReader, MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const target = process.argv[2] ?? '27_binary_delta_length.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
const { header } = await readPageHeader(file, Number(meta.dataPageOffset));
const input = await file.readAt(header.bodyOffset, header.compressedPageSize);
const reader = new ByteReader(input);
const outLen = Number(reader.varintBig());
let outPos = 0;
let tagNo = 0;
while (reader.remaining > 0 && tagNo < 90) {
  const tagStart = reader.offset;
  const tag = reader.u8();
  const kind = tag & 3;
  tagNo++;
  let detail = '';
  let advance = 0;
  if (kind === 0) {
    const six = tag >> 2;
    let litLen: number;
    if (six < 60) litLen = six + 1;
    else { const ex = six - 59; litLen = 1; for (let i = 0; i < ex; i++) litLen += reader.u8() << (8 * i); }
    detail = `LIT len=${litLen}`;
    advance = litLen;
    outPos += litLen;
  } else if (kind === 1) {
    const len = 4 + (tag >> 2);
    const off = ((tag & 0xe0) << 3) | reader.u8();
    detail = `COPY1 len=${len} off=${off}`;
    outPos += len;
  } else if (kind === 2) {
    const len = 1 + (tag >> 2);
    const off = reader.u8() | (reader.u8() << 8);
    detail = `COPY2 len=${len} off=${off}`;
    outPos += len;
  } else {
    const len = 1 + (tag >> 2);
    const off = (reader.u8() | (reader.u8() << 8) | (reader.u8() << 16) | (reader.u8() << 24)) >>> 0;
    detail = `COPY4 len=${len} off=${off}`;
    outPos += len;
  }
  if (tagNo >= 72) console.log(`#${tagNo} @${tagStart} tag=0x${tag.toString(16)} ${detail} -> outPos=${outPos}`);
  reader.offset += advance;
}
console.log('outLen cap =', outLen, 'reader', reader.offset, '/', input.length);

