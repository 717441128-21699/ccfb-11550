import { readFileSync, writeFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const target = process.argv[2];
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const lines: string[] = [];
for (const cc of metadata.rowGroups[0].columns) {
  const m = cc.metaData!;
  let offset = Number(m.dictionaryPageOffset ?? m.dataPageOffset);
  const end = Number(m.dataPageOffset) + Number(m.totalCompressedSize);
  while (offset < end) {
    const { header } = await readPageHeader(file, offset);
    lines.push(`${header.bodyOffset} ${header.compressedPageSize}`);
    offset = header.bodyOffset + header.compressedPageSize;
  }
}
writeFileSync('tests/data/_pages.txt', lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));

