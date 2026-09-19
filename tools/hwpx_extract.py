#!/usr/bin/env python3
# hwpx_extract.py — HWPX(한글) 별표 파일에서 본문과 표를 구조 보존하며 추출
# 표는 셀 좌표(rowAddr/colAddr)와 병합정보(rowSpan/colSpan)를 읽어 행×열로 복원한다.
import zipfile, sys, re, json
from xml.etree import ElementTree as ET

NS = lambda t: t.split('}')[-1]   # 네임스페이스 제거

def t_text(t):
    """<hp:t>의 전체 텍스트. 안에 <hp:fwSpace/>(고정폭 공백) 같은 자식이 끼면
    el.text는 그 앞까지만 담기므로 자식의 tail까지 모아야 한다.
    (이걸 빠뜨려 '13. 컨베이어등을 사용하여' 가 '13.용하여'로 잘리던 버그)"""
    out = [t.text or '']
    for ch in t:
        tag = NS(ch.tag)
        if tag in ('fwSpace', 'tab'): out.append(' ')
        elif tag in ('lineBreak', 'nbSpace'): out.append(' ')
        else: out.append(''.join(ch.itertext()))
        out.append(ch.tail or '')
    return ''.join(out)

def cell_text(cell):
    """셀 안의 모든 <t> 텍스트를 문단 단위로 잇는다."""
    parts, buf = [], []
    for el in cell.iter():
        tag = NS(el.tag)
        if tag == 't':
            buf.append(t_text(el))
        elif tag == 'p' and buf:
            parts.append(''.join(buf)); buf = []
    if buf: parts.append(''.join(buf))
    s = ' '.join(x.strip() for x in parts if x.strip())
    return re.sub(r'\s+', ' ', s).strip()

def parse_table(tbl):
    """<tbl>을 2차원 리스트로. 병합 셀은 같은 값을 채워 넣는다."""
    cells = []
    maxr = maxc = 0
    for tr in tbl.iter():
        if NS(tr.tag) != 'tc': continue
        addr = span = None
        for ch in tr:
            if NS(ch.tag) == 'cellAddr': addr = ch
            elif NS(ch.tag) == 'cellSpan': span = ch
        if addr is None: continue
        r, c = int(addr.get('rowAddr', 0)), int(addr.get('colAddr', 0))
        rs = int(span.get('rowSpan', 1)) if span is not None else 1
        cs = int(span.get('colSpan', 1)) if span is not None else 1
        cells.append((r, c, rs, cs, cell_text(tr)))
        maxr = max(maxr, r + rs); maxc = max(maxc, c + cs)
    grid = [['' for _ in range(maxc)] for _ in range(maxr)]
    for r, c, rs, cs, t in cells:
        for i in range(r, min(r + rs, maxr)):
            for j in range(c, min(c + cs, maxc)):
                if not grid[i][j]: grid[i][j] = t
    return grid

def extract(path):
    """문서를 순서대로 훑어 문단 텍스트와 표를 블록 리스트로 반환."""
    with zipfile.ZipFile(path) as z:
        secs = sorted(n for n in z.namelist() if re.match(r'Contents/section\d+\.xml$', n))
        blocks = []
        for s in secs:
            root = ET.fromstring(z.read(s))
            for p in root.iter():
                if NS(p.tag) != 'p': continue
                tbl = None
                for el in p.iter():
                    if NS(el.tag) == 'tbl': tbl = el; break
                if tbl is not None:
                    g = parse_table(tbl)
                    if g and any(any(row) for row in g): blocks.append(('table', g))
                else:
                    buf = [t_text(el) for el in p.iter() if NS(el.tag) == 't']
                    t = re.sub(r'\s+', ' ', ''.join(buf)).strip()
                    if t: blocks.append(('text', t))
        # 표 중복 제거(중첩 <p> 때문에 같은 표가 두 번 잡힐 수 있음)
        out, seen = [], set()
        for kind, v in blocks:
            key = json.dumps(v, ensure_ascii=False) if kind == 'table' else None
            if kind == 'table':
                if key in seen: continue
                seen.add(key)
            out.append((kind, v))
        return out

def to_markdown(blocks):
    lines = []
    for kind, v in blocks:
        if kind == 'text':
            lines.append(v)
        else:
            if not v: continue
            head = v[0]
            lines.append('| ' + ' | '.join(x or ' ' for x in head) + ' |')
            lines.append('|' + '---|' * len(head))
            for row in v[1:]:
                lines.append('| ' + ' | '.join(x or ' ' for x in row) + ' |')
    return '\n'.join(lines)

if __name__ == '__main__':
    b = extract(sys.argv[1])
    print(to_markdown(b))
