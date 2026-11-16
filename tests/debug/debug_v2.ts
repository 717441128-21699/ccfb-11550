import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressPage } from '../../src/core/codecs.js';

const target = process.argv[2] ?? '23_bool_v2.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
const { header } = await readPageHeader(file, Number(meta.dataPageOffset));
const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
const body = await decompressPage(comp, { codec: meta.codec, pageLabel: 'd', uncompressedSize: header.uncompressedPageSize });
const h = header.dataPageHeaderV2!;
console.log('V2 numValues', h.numValues, 'numNulls', h.numNulls, 'numRows', h.numRows, 'repLen', h.repetitionLevelsByteLength, 'defLen', h.definitionLevelsByteLength, 'isCompressed', h.isCompressed);
console.log('body len', body.length, 'hex:', [...body].map((b) => b.toString(16).padStart(2, '0')).join(' '));

