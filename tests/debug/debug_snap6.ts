import { readFileSync } from 'node:fs';
import { ByteReader, MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressSnappy } from '../../src/core/codecs.js';

const target = process.argv[2] ?? '27_binary_delta_length.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
const { header } = await readPageHeader(file, Number(meta.dataPageOffset));
const input = await file.readAt(header.bodyOffset, header.compressedPageSize);

// Reference output from python-snappy is 1600 bytes; decode ours and find where
// tag accounting first diverges by also computing expected via a strict walk.
const reader = new ByteReader(input);
const outLen = Number(reader.varintBig());
let outPos = 0;
let tagNo = 0;
const marks: number[] = [];
while (reader.remaining > 0) {
  const at = reader.offset;
  const tag = reader.u8();
  const kind = tag & 3;
  tagNo++;
  let len = 0;
  if (kind === 0) {
    const six = tag >> 2;
    if (six < 60) len = six + 1;
    else {
      const ex = six - 59;
      let stored = 0;
      for (let i = 0; i < ex; i++) stored |= reader.u8() << (8 * i);
      len = stored + 1;
    }
    reader.offset += len;
  } else if (kind === 1) {
    len = 4 + (tag >> 2);
    reader.u8();
  } else if (kind === 2) {
    len = 1 + (tag >> 2);
    reader.u8(); reader.u8();
  } else {
    len = 1 + (tag >> 2);
    reader.u8(); reader.u8(); reader.u8(); reader.u8();
  }
  outPos += len;
  if (tagNo >= 70 && tagNo <= 80) {
    console.log(`#${tagNo} @${at} tag=0x${tag.toString(16)} kind=${kind} emit=${len} outPos=${outPos}`);
  }
  marks.push(outPos);
}
console.log('walk total', outPos, 'declared', outLen, 'tags', tagNo, 'readerConsumed', reader.offset, input.length);

// Now actual decode and compare output bytes to reference (python dump).
try {
  const out = decompressSnappy(input, outLen);
  console.log('decoder OK', out.length);
} catch (e) {
  console.log('decoder FAIL', e instanceof Error ? e.message : String(e));
}

