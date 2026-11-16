import { readFileSync, writeFileSync } from 'node:fs';
import { MemoryFile } from '../../src/core/io.js';
import { readFooter, readPageHeader, buildSchemaTree, leafNodes } from '../../src/core/metadata.js';
import { decompressPage } from '../../src/core/codecs.js';
import { Encoding } from '../../src/core/types.js';

const target = process.argv[2] ?? '26_strings_delta.parquet';
const colName = process.argv[3] ?? 's';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const leaves = leafNodes(buildSchemaTree(metadata.schema));
const ci = leaves.findIndex((n) => n.name === colName);
const meta = metadata.rowGroups[0].columns[ci].metaData!;
let offset = Number(meta.dictionaryPageOffset ?? meta.dataPageOffset);
const end = offset + Number(meta.totalCompressedSize);
while (offset < end) {
  const { header } = await readPageHeader(file, offset);
  if (header.dataPageHeader) {
    const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
    const body = await decompressPage(comp, { codec: meta.codec, pageLabel: 'd', uncompressedSize: header.uncompressedPageSize });
    writeFileSync('tests/data/_delta_s.bin', body);
    console.log('wrote body', body.length, 'encoding', Encoding[header.dataPageHeader.encoding]);
    break;
  }
  offset = header.bodyOffset + header.compressedPageSize;
}

