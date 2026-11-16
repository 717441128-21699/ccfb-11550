"""Use pyarrow's low-level metadata to print authoritative page boundaries by
re-walking the thrift page headers with a tiny manual compact decoder."""
import sys
import struct

path = sys.argv[1]
data = open(path, 'rb').read()


def read_varint(buf, p):
    result = 0
    shift = 0
    while True:
        b = buf[p]; p += 1
        result |= (b & 0x7f) << shift
        if not (b & 0x80):
            return result, p
        shift += 7


def zigzag(n):
    return (n >> 1) ^ -(n & 1)


def walk_page_header(buf, p):
    start = p
    last_id = 0
    info = {}
    while True:
        h = buf[p]; p += 1
        if h == 0:
            return info, p, p - start
        delta = (h >> 4) & 0x0f
        ct = h & 0x0f
        if delta == 0:
            fid, p = read_varint(buf, p)
            fid = zigzag(fid)
        else:
            fid = last_id + delta
        last_id = fid
        if ct in (4, 5, 6):
            v, p = read_varint(buf, p)
            if ct != 6:
                v = zigzag(v)
            info.setdefault('fields', []).append((fid, ct, v))
        elif ct in (1, 2):
            info.setdefault('fields', []).append((fid, ct, ct == 1))
        elif ct == 8:
            ln, p = read_varint(buf, p)
            info.setdefault('fields', []).append((fid, ct, ln))
            p += ln
        elif ct == 12:
            # nested struct: recurse to skip it properly
            sub, p, _ = walk_page_header(buf, p)
            info.setdefault('fields', []).append((fid, 12, sub))
        else:
            raise ValueError(f'unexpected ct {ct} in page header at {p}')


import pyarrow.parquet as pq
pf = pq.ParquetFile(path)
rg = pf.metadata.row_group(0)
for ci in range(rg.num_columns):
    col = rg.column(ci)
    start = col.dictionary_page_offset or col.data_page_offset
    end = col.data_page_offset + col.total_compressed_size
    p = start
    print(f'--- column {ci} ({col.path_in_schema}) start={start} end={end}')
    while p < end:
        info, after, hlen = walk_page_header(data, p)
        fields = {fid: val for fid, ct, val in info['fields']}
        ptype = fields.get(1)
        usize = fields.get(2)
        csize = fields.get(3)
        print(f'  header@{p} hlen={hlen} type={ptype} uncomp={usize} comp={csize} body@{p + hlen}')
        p = p + hlen + (csize or 0)
