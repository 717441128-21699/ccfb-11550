stream = bytes([
    0x07, 0xc6, 0x94, 0x66, 0x18, 0x00, 0x21, 0x37, 0xb7, 0x4f, 0xce, 0xe1,
    0x7c, 0x67, 0x7f, 0x16, 0x87, 0x6f, 0x24, 0x12, 0x60, 0xa3, 0x0b,
])


def readvar(b, p):
    raw = []
    r = 0
    s = 0
    while True:
        x = b[p]
        p += 1
        raw.append(hex(x))
        r |= (x & 0x7f) << s
        if not x & 0x80:
            return r, p, raw
        s += 7


p = 0
total = 0
while p < len(stream) and total < 160:
    h, p, raw = readvar(stream, p)
    if h & 1:
        cnt = h >> 1
        v = stream[p]
        p += 1
        total += cnt
        print(f'RLE hdr={h} bytes={raw} count={cnt} v={v}')
    else:
        groups = h >> 1
        cnt = groups * 8
        nb = (cnt + 7) // 8
        print(f'BITPACK hdr={h} bytes={raw} groups={groups} values={cnt} databytes={nb}')
        p += nb
        total += cnt
print('total', total, 'consumed', p, 'streamlen', len(stream))
