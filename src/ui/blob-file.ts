import { CachedFile, type RandomAccessFile } from '../core/io.js';

/** Random-access source over a browser File/Blob using range slices. */
export class BlobFile implements RandomAccessFile {
  readonly size: number;
  readonly name: string;

  constructor(private readonly blob: Blob, name?: string) {
    this.blob = blob;
    this.size = blob.size;
    this.name = name ?? (blob as File).name ?? 'dropped.parquet';
  }

  async readAt(position: number, length: number): Promise<Uint8Array> {
    const end = Math.min(position + length, this.blob.size);
    const slice = this.blob.slice(position, end);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

export function openParquetSource(blob: Blob): CachedFile {
  // 4 MiB cache blocks keep random access bounded even for multi-GB files.
  return new CachedFile(new BlobFile(blob), 4 * 1024 * 1024, 300 * 1024 * 1024);
}
