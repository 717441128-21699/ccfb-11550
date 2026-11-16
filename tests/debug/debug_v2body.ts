import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';

const bytes = readFileSync('tests/data/23_bool_v2.parquet');
const file = new MemoryFile(bytes, 'x');
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
const { header } = await readPageHeader(file, Number(meta.dataPageOffset));
const body = await file.readAt(header.bodyOffset, header.compressedPageSize);
const h = header.dataPageHeaderV2!;
console.log('defLen', h.definitionLevelsByteLength, 'repLen', h.repetitionLevelsByteLength);
console.log('full body:', [...body].map((b) => b.toString(16).padStart(2, '0')).join(' '));
const dataOff = h.repetitionLevelsByteLength + h.definitionLevelsByteLength;
console.log('data region @', dataOff, ':', [...body.subarray(dataOff)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

