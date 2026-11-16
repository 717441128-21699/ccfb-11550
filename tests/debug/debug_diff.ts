import { readFileSync } from 'node:fs';
import { ByteReader, MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const target = process.argv[2] ?? '27_binary_delta_length.parquet';
const ref = readFileSync('tests/data/_ref_snappy.bin');
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
const { header } = await readPageHeader(file, Number(meta.dataPageOffset));
const input = await file.readAt(header.bodyOffset, header.compressedPageSize);

const reader = new ByteReader(input);
const outLen = Number(reader.varintBig());
const out = new Uint8Array(outLen);
let outPos = 0;
let tagNo = 0;
let firstDiff = -1;

function check(start: number, end: number, tag: number): void {
  for (let i = start; i < end; i++) {
    if (i >= ref.length || out[i] !== ref[i]) {
      if (firstDiff < 0) firstDiff = i;
      console.log(`FIRST DIFF at out[${i}] tag#${tagNo} tag=0x${tag.toString(16)} mine=0x${out[i]?.toString(16)} ref=0x${ref[i]?.toString(16)}`);
      return;
    }
  }
}

while (reader.remaining > 0) {
  const tag = reader.u8();
  const kind = tag & 3;
  tagNo++;
  const before = outPos;
  if (kind === 0) {
    const six = tag >> 2;
    let litLen: number;
    if (six < 60) litLen = six + 1;
    else {
      const ex = six - 59;
      let stored = 0;
      for (let i = 0; i < ex; i++) stored |= reader.u8() << (8 * i);
      litLen = stored + 1;
    }
    out.set(reader.slice(litLen), outPos);
    outPos += litLen;
  } else if (kind === 1) {
    const len = 4 + ((tag >> 2) & 0x07);
    const off = ((tag & 0xe0) << 3) | reader.u8();
    if (tagNo >= 35 && tagNo <= 42) {
      console.log(`tag#${tagNo} 0x${tag.toString(16)} COPY1 len=${len} off=${off} outPos=${outPos}`);
    }
    for (let i = 0; i < len; i++) out[outPos + i] = out[outPos - off + i];
    outPos += len;
  } else if (kind === 2) {
    const len = 1 + (tag >> 2);
    const off = reader.u8() | (reader.u8() << 8);
    for (let i = 0; i < len; i++) out[outPos + i] = out[outPos - off + i];
    outPos += len;
  } else {
    const len = 1 + (tag >> 2);
    const off = (reader.u8() | (reader.u8() << 8) | (reader.u8() << 16) | (reader.u8() << 24)) >>> 0;
    for (let i = 0; i < len; i++) out[outPos + i] = out[outPos - off + i];
    outPos += len;
  }
  check(before, Math.min(outPos, outLen), tag);
  if (firstDiff >= 0) {
    console.log('divergence context: tag#', tagNo, 'outPos', outPos, 'cap', outLen);
    break;
  }
}
if (firstDiff < 0) console.log('output matches reference for', outPos, 'bytes');

