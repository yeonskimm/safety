#!/usr/bin/env python3
# build_kb.py — law_kb.json을 정비해 law_kb.v2.json 생성
#  ① 공백 노이즈 정규화: " ." → ".", "제 3 자" → "제3자", 연속 공백 정리 (검색 불일치·토큰 낭비 제거)
#  ② 별표 청크 병합: annex_chunks.json → laws[*].annexes
#  ③ 파싱 오염 조문 격리: bad=true 표시 (검색에서 제외). 원본 재생성 전까지의 임시 조치
#  ④ meta에 빌드 정보·알려진 문제 기록
# 주의: 조문 본문의 '내용'은 어떤 경우에도 새로 만들거나 추측해 채우지 않는다. 정규화와 표시만 한다.
import json, re, sys, datetime

SRC, ANN, OUT = 'law_kb.json', 'annex_chunks.json', 'law_kb.v2.json'

# 원본 파싱이 깨진 조문 (본문이 다른 조문 조각으로 덮임) — 재생성 시 이 목록을 비울 것
BAD = {
    ('sanan_law', 1, 0):  '본칙 제1조(목적)가 부칙 제1조(시행일)로 덮임',
    ('kijun_rule', 2, 0): '본칙 제2조(정의)가 부칙 적용례로 덮임',
    ('sanan_law', 40, 0): '본문이 법 제174조(형벌과 수강명령 등의 병과) 조각으로 덮임',
    ('sanan_law', 51, 0): '본문이 법 제174조 조각으로 덮임',
    ('sanan_law', 63, 0): '본문이 법 제174조 조각으로 덮임',
}

# 마지막 조문이 흡수한 '부칙 <…>' 이하와 '[별표 N] …' 목차를 잘라낸다.
# 조문 본문을 새로 만들지 않고, 뒤에 달라붙은 다른 구간을 제거만 한다.
def cut_tail(text: str):
    cut = len(text)
    m = re.search(r'\s*부칙\s*<', text)
    if m and m.start() > 40: cut = min(cut, m.start())
    m2 = re.search(r'\s*\[별표\s*\d+(?:의\s*\d+)?\]\s*\S', text)      # 별표 목차 시작
    if m2 and m2.start() > 40: cut = min(cut, m2.start())
    return (text[:cut].rstrip(), len(text) - cut) if cut < len(text) else (text, 0)

def norm(s: str) -> str:
    if not s: return s
    s = s.replace('\u00a0', ' ')
    s = re.sub(r'\s+([.,])', r'\1', s)                 # " ." → "."  " ," → ","
    s = re.sub(r'([.,])(?=[^\s\d])', r'\1 ', s)        # 마침표 뒤 붙은 글자 띄우기
    s = re.sub(r'제\s+(\d)', r'제\1', s)                # "제 3 자" → "제3자"
    s = re.sub(r'(\S)\s+([)\]])', r'\1\2', s)            # "제출 )" → "제출)"
    s = re.sub(r'([(\[])\s+', r'\1', s)
    s = re.sub(r'(\d)\s*,\s*(\d{3})\b', r'\1,\2', s)     # 금액 "1, 000" → "1,000"
    s = re.sub(r'(\d)\s*조의\s*(\d)', r'\1조의\2', s)
    s = re.sub(r'별표\s+(\d)', r'별표 \1', s)
    s = re.sub(r'<\s*(개정|신설|전문개정|제목개정)\s*', r'<\1 ', s)
    s = re.sub(r'\[\s+', '[', s); s = re.sub(r'\s+\]', ']', s)
    s = re.sub(r'\(\s+', '(', s); s = re.sub(r'\s+\)', ')', s)
    s = re.sub(r'[ \t]{2,}', ' ', s)
    return s.strip()

def main():
    kb = json.load(open(SRC, encoding='utf-8'))
    try:
        ann = json.load(open(ANN, encoding='utf-8'))
    except FileNotFoundError:
        ann = []; print('⚠ annex_chunks.json 없음 — 별표 없이 빌드')

    stats = {'norm': 0, 'bad': 0, 'annex': 0, 'cut': 0, 'cutchars': 0}
    for lk, law in kb['laws'].items():
        for a in law['articles']:
            t0, ti = a['text'], a.get('title', '')
            a['text'], a['title'] = norm(t0), norm(ti)
            a['text'], nc = cut_tail(a['text'])
            if nc:
                stats['cut'] += 1; stats['cutchars'] += nc
                print(f"  ✂ {lk} 제{a['jo']}조: 뒤에 붙은 부칙·별표 목차 {nc:,}자 제거")
            if a['text'] != t0: stats['norm'] += 1
            key = (lk, a['jo'], a.get('ui') or 0)
            if key in BAD:
                a['bad'] = BAD[key]; stats['bad'] += 1
        law['annexes'] = []

    for c in ann:
        law = kb['laws'].get(c['lawKey'])
        if not law: print('❌ 알 수 없는 법령키:', c['lawKey']); continue
        law['annexes'].append({
            'no': c['no'], 'title': norm(c['title']), 'ref': c.get('ref'),
            'amend': c.get('amend'), 'part': c['part'], 'parts': c['parts'],
            'head': norm(c.get('head', '')), 'text': norm(c['text']),
        })
        stats['annex'] += 1

    kb['meta'].update({
        '빌드': datetime.date.today().isoformat(),
        '빌드버전': 'v2',
        '정규화': '공백·문장부호 정리 적용',
        '별표': f"{len({(a['no'], lk) for lk, l in kb['laws'].items() for a in l['annexes']})}종 {stats['annex']}청크 (HWPX 원본 추출)",
        '알려진문제': [f"{k[0]} 제{k[1]}조: {v} (검색 제외)" for k, v in BAD.items()],
    })
    json.dump(kb, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    import os
    print(f"정규화 {stats['norm']:,}개 / 꼬리 제거 {stats['cut']}개({stats['cutchars']:,}자) / 오염 격리 {stats['bad']}개 / 별표 청크 {stats['annex']}개")
    print(f"{SRC} {os.path.getsize(SRC):,}B → {OUT} {os.path.getsize(OUT):,}B")
    for lk, law in kb['laws'].items():
        ann_no = sorted({a['no'] for a in law['annexes']}, key=lambda x: [int(y) for y in x.split('의')])
        print(f"  {law['name']}: 조문 {len(law['articles'])} / 별표 {len(ann_no)}종 {ann_no}")

if __name__ == '__main__':
    main()
