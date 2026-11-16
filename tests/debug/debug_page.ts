import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { CompressionCodec, PageType } from '../../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? '06_large_rows.parquet';
const bytes = readFileSync(join(here, 'data', target));
const file = new MemoryFile(bytes, target);

const { metadata } = await readFooter(file);
const rg = metadata.rowGroups[0];
const chunk = rg.columns[0];
const meta = chunk.metaData!;
console.log('file', target, 'size', bytes.length);
console.log('codec', CompressionCodec[meta.codec], 'numValues', meta.numValues.toString(),
  'dataPageOffset', meta.dataPageOffset.toString(),
  'dictOffset', meta.dictionaryPageOffset?.toString());

let offset = Number(meta.dictionaryPageOffset ?? meta.dataPageOffset);
const end = Number(meta.dataPageOffset) + Number(meta.totalCompressedSize);
let n = 0;
while (offset < end && n < 4) {
  const { header, bytesRead } = await readPageHeader(file, offset);
  console.log(`\npage ${n} type=${PageType[header.type]} hdrBytes=${bytesRead}`,
    `compressed=${header.compressedPageSize} uncompressed=${header.uncompressedPageSize}`,
    `bodyOffset=${header.bodyOffset}`);
  if (header.dataPageHeader) {
    const h = header.dataPageHeader;
    console.log('  numValues', h.numValues, 'enc', h.encoding, 'defEnc', h.definitionLevelEncoding,
      'repEnc', h.repetitionLevelEncoding);
    const body = await file.readAt(header.bodyOffset, header.compressedPageSize);
    console.log('  first 12 body bytes:', [...body.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
  }
  offset = header.bodyOffset + header.compressedPageSize;
  n++;
}

