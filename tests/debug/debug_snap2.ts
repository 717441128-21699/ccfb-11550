import { readFileSync } from 'node:fs';
import { decompressSnappy } from '../../src/core/codecs.js';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const target = process.argv[2] ?? '_snappy.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
const { header } = await readPageHeader(file, Number(meta.dataPageOffset));
const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
try {
  const out = decompressSnappy(comp, header.uncompressedPageSize);
  console.log('OK decoded', out.length, 'expected', header.uncompressedPageSize);
} catch (e) {
  console.log('FAIL', e instanceof Error ? e.message : String(e));
}

