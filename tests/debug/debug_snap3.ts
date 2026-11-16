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
const out = new Uint8Array(outLen);
let outPos = 0;
let tagNo = 0;
try {
  while (reader.remaining > 0) {
    const tag = reader.u8();
    const kind = tag & 3;
    tagNo++;
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
      if (outPos + litLen > outLen) {
        throw new Error(`literal overflow tag#${tagNo} need ${outPos + litLen} cap ${outLen} readerOff=${reader.offset}`);
      }
      out.set(reader.slice(litLen), outPos);
      outPos += litLen;
    } else if (kind === 1) {
      const len = 4 + (tag >> 2);
      const off = (((tag >> 5) & 0x07) << 8) | reader.u8();
      if (outPos + len > outLen) throw new Error(`copy1 overflow tag#${tagNo} off=${off}`);
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
  }
  console.log('manual OK', outPos, outLen);
} catch (e) {
  console.log('manual FAIL tag#' + tagNo, e instanceof Error ? e.message : String(e), 'outPos', outPos);
}

