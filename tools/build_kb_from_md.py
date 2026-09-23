#!/usr/bin/env python3
"""build_kb_from_md.py — 법제처 원문(Markdown)으로 law_kb.json의 '조문'을 통째로 다시 만든다.

원문: legalize-kr 저장소(법제처 Open API → Markdown 미러)의 kr/<법령>/<구분>.md
      https://github.com/legalize-kr/legalize-kr
별표: 원문 미러에 없으므로 기존 law_kb.json의 annexes(HWPX 추출본)를 그대로 유지한다.

사용 예 (2026-09-23 시행 기준으로 만든 방법):
  git clone --filter=blob:none --sparse https://github.com/legalize-kr/legalize-kr lk
  cd lk && git sparse-checkout set kr/산업안전보건법 kr/산업안전보건기준에관한규칙
  # 법률은 '오늘 시행 중인' 판을 골라 꺼낸다 (최신 커밋이 시행 전 개정일 수 있음)
  git log --format='%h %ad %s' --date=short -- kr/산업안전보건법/법률.md
  git show <커밋>:kr/산업안전보건법/법률.md > /tmp/법률.md
  cd ..
  python3 tools/build_kb_from_md.py law_kb.json \\
      sanan_law=/tmp/법률.md \\
      sanan_decree=lk/kr/산업안전보건법/시행령.md \\
      sanan_rule=lk/kr/산업안전보건법/시행규칙.md \\
      kijun_rule=lk/kr/산업안전보건기준에관한규칙/고용노동부령.md

원칙: 조문 내용은 원문 그대로 옮긴다. 하는 일은 표기 정리(마크다운 기호 제거·공백 정규화),
      선 문자 표(┌│┐)를 한 줄 텍스트로 펴기, 이미지만 있는 자리에 '원문 참조' 표시뿐이다.
"""
import json, re, sys, os, datetime, difflib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_kb import norm   # 기존 KB와 같은 정규화 규칙을 쓴다(검색 토큰 일관성)

BOX = '┌┐└┘├┤┬┴┼─━┃┏┓┗┛┣┫┳┻╋'
IMG_NOTE = '(그림·수식은 국가법령정보센터 원문 참조)'

def _is_item_start(t):
    return bool(re.match(r'^(\d+\.|[가-하]\.|\(\d+\)|[①-⑳]|주\)|비\s*고|※|[A-Za-z]\s*[:=])', t))   # 목록 기호·식의 변수 정의(V: …)는 새 행

def flatten_table(block_lines):
    """선 문자 표를 '칸 | 칸 / 다음 행' 형태의 한 줄로 편다. 테두리 줄은 버린다.
    한 칸짜리 행이 앞 행의 이어짐(줄바꿈으로 끊긴 단어)이면 붙인다."""
    rows = []
    for ln in block_lines:
        s = ln.strip()
        if not s or all(ch in BOX + ' │' for ch in s):
            continue
        cells = [c.strip() for c in s.strip('│').split('│')]
        cells = [c for c in cells if c]
        if not cells:
            continue
        if (len(cells) == 1 and rows and ' | ' not in rows[-1] and not _is_item_start(cells[0])
                and not re.search(r'[.:)]$', rows[-1])):
            rows[-1] = rows[-1] + cells[0]          # 줄바꿈으로 끊긴 칸 → 이어 붙임
        else:
            rows.append(' | '.join(cells))
    return ('〔표〕 ' + ' / '.join(rows) + ' 〔표 끝〕') if rows else ''

def clean_body(raw):
    lines = raw.replace('\r', '').split('\n')
    out, buf, img_only = [], [], 0
    had_table = False
    for ln in lines + ['<<END>>']:
        s = ln.strip()
        if s.startswith(('┌', '│', '├', '└')):
            buf.append(s); continue
        if not s:                                   # 빈 줄: 표 안이면 표를 끊지 않는다
            continue
        if s == '</img>':
            continue
        if buf:
            t = flatten_table(buf); buf = []
            if t: out.append(t); had_table = True
        if s == '<<END>>':
            break
        if s.startswith('<img'):
            img_only += 1; continue
        out.append(s)
    text = ' '.join(x for x in out if x)
    text = re.sub(r'\*\*', '', text).replace('\\.', '.')
    # 원문 표의 위첨자(10의 6제곱)가 텍스트 변환에서 '106'으로 평탄화된 경우를 바로잡는다 (산안규칙 제430조 필요환기량 식)
    text = text.replace('노출기준)×106', '노출기준)×10⁶')
    text = re.sub(r'\s+', ' ', text).strip()
    # 이미지가 있었는데 같은 조문에 텍스트 표가 없으면 → 원문 참조 표시(내용을 지어내지 않는다)
    if img_only and not had_table:
        text += ' ' + IMG_NOTE
    return text, img_only, had_table

def parse_md(path):
    src = open(path, encoding='utf-8').read()
    head = dict(re.findall(r"^(공포번호|공포일자|시행일자):\s*'?([^'\n]+)'?", src, re.M))
    body = src.split('\n## 부칙')[0]          # 부칙은 조문 DB에 넣지 않는다
    arts, stats = [], {'table': 0, 'img_note': 0}
    for chunk in re.split(r'\n#{5} ', body)[1:]:
        m = re.match(r'제(\d+)조(?:의(\d+))?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)', chunk)
        if not m:
            continue
        jo, ui, title = int(m.group(1)), int(m.group(2) or 0), m.group(3).strip()
        content = re.split(r'\n#{1,4} ', chunk)[0]          # 다음 장·절 제목 전까지
        content = content.split('\n', 1)[1] if '\n' in content else ''
        text, imgs, tbl = clean_body(content)
        stats['table'] += tbl; stats['img_note'] += (imgs > 0 and not tbl)
        label = f"제{jo}조" + (f"의{ui}" if ui else '')
        full = norm(f"{label}({title}) {text}")
        arts.append({'jo': jo, 'ui': ui, 'title': norm(title), 'text': full})
    return head, arts, stats

def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    kb_path = sys.argv[1]
    pairs = dict(a.split('=', 1) for a in sys.argv[2:])
    kb = json.load(open(kb_path, encoding='utf-8'))
    report, src_note = [], []
    for key, path in pairs.items():
        law = kb['laws'][key]
        head, arts, st = parse_md(path)
        old = {(a['jo'], a['ui']): a['text'] for a in law['articles']}
        new = {(a['jo'], a['ui']): a['text'] for a in arts}
        added = sorted(k for k in new if k not in old)
        removed = sorted(k for k in old if k not in new)
        sq = lambda t: re.sub(r'[\s·ㆍ,.()]|<[^>]*>|\[[^\]]*\]', '', t)
        changed = sorted(k for k in new if k in old and
                         difflib.SequenceMatcher(None, sq(old[k]), sq(new[k]), autojunk=False).ratio() < 0.97)
        law['articles'] = arts
        law['count'] = len(arts)
        ymd = head.get('시행일자', '')
        if ymd:
            y, mo, d = ymd.split('-'); law['effective'] = f"{int(y)}.{int(mo)}.{int(d)}"
        law['source'] = {'공포번호': head.get('공포번호'), '공포일자': head.get('공포일자'), '시행일자': ymd}
        fmt = lambda ks: ', '.join(f"제{j}조" + (f"의{u}" if u else '') for j, u in ks)
        report.append(f"{law['name']}: 조문 {len(arts)} | 신설 {len(added)} [{fmt(added)}] | 삭제 {len(removed)} [{fmt(removed)}] "
                      f"| 실질 변경 {len(changed)} | 표 {st['table']} | 원문참조 표시 {st['img_note']}")
        src_note.append(f"{law['name']} {law['kind']} 제{head.get('공포번호','?').lstrip('0')}호(시행 {ymd})")
    meta = kb['meta']
    meta.update({
        '출처': '국가법령정보센터(법제처 Open API) 원문 — legalize-kr Markdown 미러 경유',
        '기준': '빌드일 현재 시행 중인 조문 (공포됐으나 시행 전인 개정은 제외)',
        '조문원문': ' / '.join(src_note),
        '빌드': datetime.date.today().isoformat(),
        '정규화': '공백·문장부호 정리, 선 문자 표는 〔표〕 한 줄로 펼침, 이미지 전용 내용은 원문 참조 표시',
        '알려진문제': [],
    })
    meta.pop('보정', None)   # 수동 보정 이력은 전면 재생성으로 대체됨
    json.dump(kb, open(kb_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('\n'.join(report))

if __name__ == '__main__':
    main()
