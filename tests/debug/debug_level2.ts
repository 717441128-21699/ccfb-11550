import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressPage } from '../../src/core/codecs.js';
import { decodeHybridWithLengthPrefix } from '../../src/core/encodings.js';

const target = process.argv[2] ?? '13_int_widths.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const chunk = metadata.rowGroups[0].columns[0];
const meta = chunk.metaData!;
let offset = Number(meta.dictionaryPageOffset ?? meta.dataPageOffset);
const end = Number(meta.dataPageOffset) + Number(meta.totalCompressedSize);
while (offset < end) {
  const { header } = await readPageHeader(file, offset);
  const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
  const body = await decompressPage(comp, {
    codec: meta.codec, pageLabel: 'd', uncompressedSize: header.uncompressedPageSize,
  });
  if (header.dataPageHeader) {
    console.log('DATA page body len', body.length, 'numValues', header.dataPageHeader.numValues);
    console.log('first 16:', [...body.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
    const r = new ByteReader(body);
    const defLen = r.u32();
    console.log('def length prefix =', defLen, 'body remaining', body.length - 4);
    try {
      const defs = decodeHybridWithLengthPrefix(body, 1, header.dataPageHeader.numValues);
      console.log('defs decoded OK', defs.length, 'distinct', [...new Set(defs)]);
    } catch (e) {
      console.log('defs FAIL', e instanceof Error ? e.message : String(e));
    }
    break;
  }
  offset = header.bodyOffset + header.compressedPageSize;
}

