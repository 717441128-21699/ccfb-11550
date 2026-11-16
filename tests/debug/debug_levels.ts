import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressSnappy } from '../../src/core/codecs.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? '06_large_rows.parquet';
const bytes = readFileSync(join(here, 'data', target));
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const chunk = metadata.rowGroups[0].columns[0];
const meta = chunk.metaData!;

let offset = Number(meta.dataPageOffset);
const { header } = await readPageHeader(file, offset);
const compressed = await file.readAt(header.bodyOffset, header.compressedPageSize);
const body = decompressSnappy(compressed, header.uncompressedPageSize);
console.log('decompressed', body.length, 'bytes; first 16:',
  [...body.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
const r = new ByteReader(body);
// maxRep=0 so no rep stream; def stream:
const defLen = r.u32();
console.log('def stream length prefix =', defLen, 'remaining=', body.length - 4);
console.log('def stream bytes:', [...body.slice(4, 4 + Math.min(defLen, 16))]
  .map((b) => b.toString(16).padStart(2, '0')).join(' '));

