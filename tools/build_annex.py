#!/usr/bin/env python3
# build_annex.py — 업로드된 HWPX 별표를 law_kb용 청크로 변환
#  · 병합 셀로 중복된 값은 한 번만 남기고, 표의 각 행을 "열1 | 열2 | …" 한 줄로 만든다.
#  · 큰 별표는 검색 단위가 되도록 소제목(1., 2., 가., [별표] 항목) 기준으로 청크 분할한다.
#  · 각 청크에는 별표번호·제목·근거조문을 붙여, 검색으로 뽑아 그대로 프롬프트에 넣을 수 있게 한다.
import glob, json, re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hwpx_extract import extract

OUT = 'annex_chunks.json'
MAX_CHUNK = 1400          # 청크당 최대 글자 (프롬프트 주입 단위, LAW_SLICE보다 약간 크게 잡고 주입 시 잘림)
LAWKEY = {'산업안전보건법 시행령': 'sanan_decree', '산업안전보건법 시행규칙': 'sanan_rule',
          '산업안전보건기준에 관한 규칙': 'kijun_rule', '산업안전보건법': 'sanan_law'}

def collapse(row):
    out = []
    for c in row:
        if not out or out[-1] != c: out.append(c)
    return [c for c in out if c]

def flatten(blocks):
    lines = []
    for kind, v in blocks:
        if kind == 'text':
            lines.append(v)
        else:
            for row in v:
                r = collapse(row)
                if r: lines.append(' | '.join(r))
    out = []
    for l in lines:                      # 연속 중복 줄 제거
        l = re.sub(r'\s+', ' ', l).strip()
        if l and (not out or out[-1] != l): out.append(l)
    # 표 전체가 첫 셀에 통째로 들어간 '요약 덩어리' 줄 제거 —
    # 이 줄을 남기면 개별 행들이 중복으로 몰려 삭제되고, 검색 단위가 거대 덩어리 하나가 된다.
    flat = [re.sub(r'\s+', '', x) for x in out]
    keep = []
    for i, f in enumerate(flat):
        if len(f) > 800 and sum(1 for j, g in enumerate(flat) if i != j and g and g in f) >= 3:
            continue
        keep.append(out[i])
    return keep

def parse_header(lines, fname):
    """■ 산업안전보건법 시행규칙 [별표 4] <개정 …> / 제목(제26조제1항 등 관련)"""
    head = ' '.join(lines[:6])
    m = re.search(r'(산업안전보건법 시행규칙|산업안전보건법 시행령|산업안전보건기준에 관한 규칙|산업안전보건법)\s*\[\s*별표\s*(\d+(?:\s*의\s*\d+)?)\s*\]', head)
    law, no = (m.group(1), m.group(2).replace(' ', '')) if m else (None, None)
    if not law:                          # 파일명에서 보완
        law = ('산업안전보건법 시행규칙' if '시행규칙' in fname else
               '산업안전보건법 시행령' if '시행령' in fname else
               '산업안전보건기준에 관한 규칙' if '기준에_관한_규칙' in fname else None)
        m2 = re.search(r'별표_(\d+(?:의\d+)?)', fname); no = m2.group(1) if m2 else None
    tm = re.search(r'별표\s*\d+(?:\s*의\s*\d+)?\s*\]\s*(?:<[^>]*>)?\s*(.+?)\s*\(제', ' '.join(lines[:8]))
    title = tm.group(1).strip() if tm else None
    if not title:
        t2 = re.search(r'별표_\d+(?:의\d+)?__(.+?)_제\d+조', fname)
        title = t2.group(1).replace('_', ' ').strip() if t2 else '(제목 미상)'
    ref = re.findall(r'\(제(\d+(?:의\d+)?)조', ' '.join(lines[:8]))
    amend = re.search(r'<\s*(개정|신설)\s*([\d.\s]+)>', head)
    return law, no, title, (ref[0] if ref else None), (amend.group(2).strip() if amend else None)

def chunk(lines, law, no, title, ref):
    """소제목 단위로 묶되 MAX_CHUNK를 넘으면 쪼갠다."""
    SEC = re.compile(r'^(\d+(?:의\d+)?\.\s|[가-힣]\.\s|\d+\)\s)')
    groups, cur, curhead = [], [], ''
    for l in lines:
        if SEC.match(l) and len(' '.join(cur)) > 200:
            groups.append((curhead, cur)); cur, curhead = [l], l[:60]
        else:
            if SEC.match(l) and not curhead: curhead = l[:60]
            cur.append(l)
    if cur: groups.append((curhead, cur))
    out = []
    for head, ls in groups:
        buf = []
        for l in ls:
            if buf and len(' '.join(buf)) + len(l) > MAX_CHUNK:
                out.append((head, '\n'.join(buf))); buf = []
            buf.append(l)
        if buf: out.append((head, '\n'.join(buf)))
    return out

def main():
    ann = []
    src_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'annex_src')
    files = sorted(glob.glob(os.path.join(src_dir, '*.hwpx')))
    if not files:
        print(f"별표 HWPX가 없습니다: {src_dir}\n  사용법: python3 build_annex.py [별표폴더]"); return
    print(f"별표 원본 {len(files)}개 — {src_dir}")
    for f in files:
        fname = os.path.basename(f)
        lines = flatten(extract(f))
        law, no, title, ref, amend = parse_header(lines, fname)
        if not law or not no:
            print('❌ 헤더 파싱 실패:', fname); continue
        lk = LAWKEY[law]
        # 머리글(법령명·제목 줄) 제거
        body = [l for l in lines if not re.match(r'^■', l) and l != title and not re.match(r'^법제처\s*\d*\s*국가법령정보센터$', l)]
        chunks = chunk(body, law, no, title, ref)
        # HWPX는 같은 내용을 표 셀과 본문 문단으로 두 번 담는 경우가 있다.
        # 다른 청크에 통째로 들어 있는 청크는 버린다 (공백 제거 후 포함 관계로 판정).
        flat = [(h, t, re.sub(r'\s+', '', t)) for h, t in chunks]
        keep = []
        for i, (h, t, f) in enumerate(flat):
            # 길이가 비슷한 진짜 중복만 제거한다 (1.6배를 넘는 큰 청크가 작은 청크를 삼키지 않도록)
            if any(i != j and f and f in g and len(g) <= len(f) * 1.6 and (len(g) > len(f) or j < i)
                   for j, (_, _, g) in enumerate(flat)):
                continue
            keep.append((h, t))
        dropped = len(chunks) - len(keep)
        chunks = keep
        for i, (head, text) in enumerate(chunks):
            ann.append({'lawKey': lk, 'lawName': law, 'no': no, 'title': title, 'ref': ref,
                        'amend': amend, 'part': i + 1, 'parts': len(chunks),
                        'head': head or '', 'text': text})
        print(f"✅ {law} 별표 {no} — {title[:34]} / {len(chunks)}청크 / {sum(len(c[1]) for c in chunks):,}자"
              + (f" / 중복 {dropped}청크 제거" if dropped else '')
              + (f" / 근거 제{ref}조" if ref else '') + (f" / 개정 {amend}" if amend else ''))
    json.dump(ann, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"\n총 {len(ann)}청크 / {sum(len(a['text']) for a in ann):,}자 → {OUT}")

if __name__ == '__main__':
    main()
