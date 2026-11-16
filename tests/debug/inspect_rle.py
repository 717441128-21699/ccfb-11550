import sys, struct, snappy  # may not exist; fallback below

path = sys.argv[1]
data = open(path, 'rb').read()

# minimal footer parse is overkill; hardcode offsets discovered by TS: read page0
# Instead find first snappy block after 4-byte page header region via TS debug.
# Simpler: use pyarrow to locate, then manually scan.
import pyarrow.parquet as pq
pf = pq.ParquetFile(path)
rg = pf.metadata.row_group(0)
col = rg.column(0)
off = col.data_page_offset
# read thrift-ish: we know from TS bodyOffset=43 for large_rows; generic: scan 'PAR1' not needed.
# Just reuse TS values via argument of body offset and sizes.
body_off = int(sys.argv[2])
comp_size = int(sys.argv[3])
uncomp_size = int(sys.argv[4])
block = data[body_off:body_off + comp_size]
try:
    import snappy
    raw = snappy.decompress(block)
except ImportError:
    # cramjam alternative
    import cramjam
    raw = bytes(cramjam.snappy.decompress_raw(block))
print('raw len', len(raw), 'expected', uncomp_size)
prefix = struct.unpack('<I', raw[:4])[0]
print('def len prefix', prefix)
stream = raw[4:4 + prefix]
print('stream hex', stream.hex())
p = 0
total = 0
runs = 0
while p < len(stream) and runs < 10:
    start = p
    hdr = 0; shift = 0
    while True:
        b = stream[p]; p += 1
        hdr |= (b & 0x7f) << shift
        if not (b & 0x80): break
        shift += 7
    if hdr & 1 == 0:
        groups = hdr >> 1
        cnt = groups * 8
        cost = (cnt + 7) // 8
        print(f'@{start} BITPACK hdr={hdr} groups={groups} values={cnt} cost={cost}')
        p += cost
        total += cnt
    else:
        cnt = hdr >> 1
        val = stream[p]; p += 1
        print(f'@{start} RLE hdr={hdr} count={cnt} val={val}')
        total += cnt
    runs += 1
print('total', total, 'consumed', p, 'of', len(stream))
