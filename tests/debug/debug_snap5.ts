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
console.log('hex around 1173..1180:',
  [...input.slice(1173, 1182)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('byte @1175 = 0x' + input[1175].toString(16), 'high6=', input[1175] >> 2, 'low2=', input[1175] & 3);
console.log('next byte @1176 =', input[1176]);
// Compare against python snappy via a known-good: use node zlib? no. Instead
// verify total: maybe this is column 0; try decompressing with a fresh reader
// and report every extended-literal tag encountered.
const reader = new ByteReader(input);
const outLen = Number(reader.varintBig());
let outPos = 0;
let tagNo = 0;
while (reader.remaining > 0) {
  const at = reader.offset;
  const tag = reader.u8();
  const kind = tag & 3;
  tagNo++;
  if (kind === 0 && tag >> 2 >= 60) {
    const ex = (tag >> 2) - 59;
    let stored = 0;
    for (let i = 0; i < ex; i++) stored |= reader.u8() << (8 * i);
    const len = stored + 1;
    console.log(`extended literal #${tagNo} @${at} tag=0x${tag.toString(16)} ex=${ex} stored=${stored} len=${len} outPos=${outPos}`);
    outPos += len;
    reader.offset += len;
  } else if (kind === 0) {
    outPos += (tag >> 2) + 1;
    reader.offset += (tag >> 2) + 1;
  } else if (kind === 1) {
    reader.u8();
    outPos += 4 + (tag >> 2);
  } else if (kind === 2) {
    reader.u8(); reader.u8();
    outPos += 1 + (tag >> 2);
  } else {
    reader.u8(); reader.u8(); reader.u8(); reader.u8();
    outPos += 1 + (tag >> 2);
  }
  if (outPos > outLen) {
    console.log('exceeded at tag', tagNo, 'outPos', outPos, 'cap', outLen);
    break;
  }
}
console.log('final outPos', outPos, 'cap', outLen);

