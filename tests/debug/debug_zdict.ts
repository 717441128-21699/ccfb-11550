import { readFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressPage } from '../../src/core/codecs.js';
import { decodeDictionaryPage } from '../../src/core/column.js';

const bytes = readFileSync('tests/data/12_comprehensive.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const chunk = metadata.rowGroups[0].columns[1];
const meta = chunk.metaData!;
const dictOff = Number(meta.dictionaryPageOffset);
const { header } = await readPageHeader(file, dictOff);
console.log('page type', header.type, 'dict header', JSON.stringify(header.dictionaryPageHeader));
const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
console.log('compressed bytes', comp.length, 'head', [...comp.slice(0, 6)].map((b) => b.toString(16)).join(' '));
try {
  const body = await decompressPage(comp, { codec: meta.codec, pageLabel: 'dict', uncompressedSize: header.uncompressedPageSize });
  console.log('decompressed', body.length);
  const root = (await import('../src/core/metadata.js')).buildSchemaTree(metadata.schema);
  const leaves = (await import('../src/core/metadata.js')).leafNodes(root);
  const dict = decodeDictionaryPage(body, header, leaves[1]);
  console.log('dictionary entries', dict.length, dict.slice(0, 8));
} catch (e) {
  console.log('FAIL', e instanceof Error ? e.stack : String(e));
}

