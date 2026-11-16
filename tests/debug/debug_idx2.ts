import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressPage } from '../../src/core/codecs.js';
import { decodeRleBitPackedHybrid } from '../../src/core/encodings.js';

const target = process.argv[2] ?? '13_int_widths.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
const { header } = await readPageHeader(file, Number(meta.dataPageOffset));
const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
const body = await decompressPage(comp, { codec: meta.codec, pageLabel: 'd', uncompressedSize: header.uncompressedPageSize });

const defLen = new ByteReader(body).u32();
const p = 4 + defLen; // = 7
const bitWidth = body[p];
// Hypothesis: NO 4-byte length prefix; hybrid stream directly follows bitWidth.
const stream = body.subarray(p + 1);
const indices = decodeRleBitPackedHybrid(stream, bitWidth, 200);
console.log('no-prefix indices count', indices.length, 'first15', indices.slice(0, 15).join(','));

