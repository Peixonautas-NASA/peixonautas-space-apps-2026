"""
Gera os dados de relevo REAL da Cratera Gale usados pela Visão VR (apps/ar-vr/public/gale/).

Fontes oficiais (USGS Astrogeology, lidas por "range requests": só as janelas necessárias são
baixadas, nunca o arquivo inteiro):
  - Mars MSL Gale Merged DEM 1m (v3), HiRISE: MSL_Gale_DEM_Mosaic_1m_v3.tif (7,6 GB, float32)
    https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m
  - Mars MGS MOLA - MEX HRSC Blended DEM Global 200m (v2): Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif
    https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m

Saídas (little-endian):
  crater_200m.bin  int16  metros            (janela da cratera inteira, grade em graus)
  hirise_8m.bin    uint16 (m - base) * 10   (média de blocos 8x8 m; 0 = sem dado)
  hirise_2m.bin    uint16 (m - base) * 10   (média de blocos 2x2 m; 0 = sem dado)
  meta.json        georreferência de cada grade

Uso:  python tools/build_gale_dem.py            (só biblioteca padrão do Python)
"""
import json
import math
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HIRISE_URL = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/MSL_Gale_DEM_Mosaic_1m_v3.tif'
BLEND_URL = ('https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/'
             'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif')

CENTER = (-4.59, 137.44)  # ponto de referência da equipe (lat, lon)
CRATER_BOX = {'latMin': -7.0, 'latMax': -3.4, 'lonMin': 135.9, 'lonMax': 139.6}  # Gale tem ~154 km
LEVELS = [  # (nome, tamanho do lado em m, célula em m, linhas lidas por bloco)
    ('hirise_8m', 12000, 8, (2, 5)),  # 2 de cada 8 linhas (reduz o download 4x); todas as colunas
    ('hirise_2m', 3000, 2, None),     # todas as linhas
]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'gale')
WORKERS = 24


def rng(url, a, n, tries=5):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'Range': f'bytes={a}-{a + n - 1}'})
            data = urllib.request.urlopen(req, timeout=60).read()
            if len(data) == n:
                return data
        except Exception as e:  # rede instável: tenta de novo
            err = e
        time.sleep(1 + k)
    raise RuntimeError(f'falha lendo {url} @ {a}: {err}')


def tiff_layout(url):
    """Lê o IFD 0 de um BigTIFF não comprimido, 1 linha por strip."""
    head = rng(url, 0, 16)
    assert head[:2] == b'II' and struct.unpack('<H', head[2:4])[0] == 43, 'esperado BigTIFF little-endian'
    off = struct.unpack('<Q', head[8:16])[0]
    cnt = struct.unpack('<Q', rng(url, off, 8))[0]
    body = rng(url, off + 8, cnt * 20)
    tags = {}
    for i in range(cnt):
        tag, typ, n = struct.unpack('<HHQ', body[i * 20:i * 20 + 12])
        tags[tag] = (typ, n, body[i * 20 + 12:i * 20 + 20])

    def val(tag):
        typ, n, raw = tags[tag]
        fmt = {3: 'H', 4: 'I', 16: 'Q', 12: 'd'}[typ]
        sz = struct.calcsize(fmt)
        if n * sz <= 8:
            return struct.unpack('<' + fmt * n, raw[:n * sz])
        p = struct.unpack('<Q', raw)[0]
        return struct.unpack('<' + fmt * n, rng(url, p, n * sz))

    w, h, bits = val(256)[0], val(257)[0], val(258)[0]
    assert val(259)[0] == 1, 'esperado sem compressão'
    assert val(278)[0] == 1, 'esperado 1 linha por strip'
    typ, n, raw = tags[273]
    p = struct.unpack('<Q', raw)[0]
    first = struct.unpack('<Q', rng(url, p, 8))[0]
    second = struct.unpack('<Q', rng(url, p + 8, 8))[0]
    last = struct.unpack('<Q', rng(url, p + 8 * (n - 1), 8))[0]
    row_bytes = w * bits // 8
    assert second - first == row_bytes and last == first + (n - 1) * row_bytes, 'linhas não contíguas'
    return {'w': w, 'h': h, 'bits': bits, 'first': first, 'row_bytes': row_bytes,
            'scale': val(33550), 'tie': val(33922)}


def read_rows(url, lay, rows, c0, ncols):
    bpp = lay['bits'] // 8

    def one(r):
        return r, rng(url, lay['first'] + r * lay['row_bytes'] + c0 * bpp, ncols * bpp)

    with ThreadPoolExecutor(WORKERS) as ex:
        return dict(ex.map(one, rows))


def build_crater():
    lay = tiff_layout(BLEND_URL)
    step = lay['scale'][0]  # graus por pixel
    lon0, lat0 = lay['tie'][3], lay['tie'][4]
    c0 = int((CRATER_BOX['lonMin'] - lon0) / step)
    c1 = int(math.ceil((CRATER_BOX['lonMax'] - lon0) / step))
    r0 = int((lat0 - CRATER_BOX['latMax']) / step)
    r1 = int(math.ceil((lat0 - CRATER_BOX['latMin']) / step))
    ncols, nrows = c1 - c0, r1 - r0
    print(f'cratera 200 m: {ncols} x {nrows}')
    rows = read_rows(BLEND_URL, lay, range(r0, r1), c0, ncols)
    with open(os.path.join(OUT, 'crater_200m.bin'), 'wb') as f:
        for r in range(r0, r1):
            f.write(rows[r])  # int16 LE, igual ao arquivo original
    return {
        'file': 'crater_200m.bin', 'type': 'int16', 'w': ncols, 'h': nrows, 'nodata': -32768,
        'lonMin': lon0 + c0 * step, 'latMax': lat0 - r0 * step, 'step': step,
        'source': 'USGS Mars MGS MOLA - MEX HRSC Blended DEM Global 200m v2',
    }


def build_hirise(lay, name, size_m, cell, row_pick):
    R = 3396190.0  # raio da projeção do DEM (Mars 2000 Sphere)
    x0, y0 = lay['tie'][3], lay['tie'][4]
    cx = R * math.radians(CENTER[1])
    cy = R * math.radians(CENTER[0])
    n = int(size_m // cell)
    pc0 = int(round(cx - x0 - size_m / 2))  # coluna (m) do canto oeste
    pr0 = int(round(y0 - cy - size_m / 2))  # linha (m) do canto norte
    pc0 -= pc0 % cell
    pr0 -= pr0 % cell
    picks = row_pick or range(cell)
    rows_needed = [pr0 + i * cell + k for i in range(n) for k in picks]
    print(f'{name}: {n} x {n} células de {cell} m, lendo {len(rows_needed)} linhas de {n * cell * 4 // 1024} KB')
    t = time.time()
    rows = read_rows(HIRISE_URL, lay, rows_needed, pc0, n * cell)
    print(f'  baixado em {time.time() - t:.0f} s')
    grid = [None] * (n * n)
    for i in range(n):
        acc = [0.0] * n
        cnt = [0] * n
        for k in picks:
            vals = struct.unpack(f'<{n * cell}f', rows[pr0 + i * cell + k])
            for j in range(n):
                for v in vals[j * cell:(j + 1) * cell]:
                    if v > -1e30:  # nodata = -3.4e38
                        acc[j] += v
                        cnt[j] += 1
        for j in range(n):
            grid[i * n + j] = acc[j] / cnt[j] if cnt[j] else None
    valid = [v for v in grid if v is not None]
    base = math.floor(min(valid)) - 1
    assert (max(valid) - base) * 10 < 65535, 'faixa de altitude grande demais para uint16 em decímetros'
    with open(os.path.join(OUT, f'{name}.bin'), 'wb') as f:
        f.write(struct.pack(f'<{n * n}H', *[0 if v is None else max(1, round((v - base) * 10)) for v in grid]))
    print(f'  altitude {min(valid):.1f} .. {max(valid):.1f} m, sem dado: {n * n - len(valid)} células')
    return {
        'file': f'{name}.bin', 'type': 'uint16dm', 'w': n, 'h': n, 'base': base, 'cell': cell,
        # canto noroeste em metros da projeção equirretangular do DEM (R = 3396190 m)
        'x0': x0 + pc0, 'y0': y0 - pr0, 'R': R,
        'source': 'USGS Mars MSL Gale Merged DEM 1m v3 (HiRISE)',
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = {'center': {'lat': CENTER[0], 'lon': CENTER[1]}, 'levels': []}
    meta['crater'] = build_crater()
    lay = tiff_layout(HIRISE_URL)
    print('HiRISE DEM:', lay['w'], 'x', lay['h'])
    for name, size_m, cell, pick in LEVELS:
        meta['levels'].append(build_hirise(lay, name, size_m, cell, pick))
    with open(os.path.join(OUT, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    print('ok ->', os.path.normpath(OUT))


if __name__ == '__main__':
    sys.exit(main())
