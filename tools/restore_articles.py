#!/usr/bin/env python3
"""restore_articles.py — 파싱 오염·잘림 조문을 법제처 원문(Markdown)으로 교체한다.

원문: legalize-kr 저장소(법제처 Open API → Markdown 미러)의 kr/<법령>/<구분>.md
사용: python3 tools/restore_articles.py law_kb.json <원문.md> <법키> <조문...>
  예) python3 tools/restore_articles.py law_kb.json 법률.md sanan_law 1 167 168 169 174 175
  조문은 '167' 또는 '12의2' 형식. 교체한 조문의 bad 플래그는 제거한다.
원문 파일의 공포번호·시행일자를 meta.보정 에 기록한다(어느 버전으로 복구했는지 추적용).
"""
import json, re, sys

def parse_md(path):
    src = open(path, encoding='utf-8').read()
    head = dict(re.findall(r"^(공포번호|공포일자|시행일자):\s*'?([^'\n]+)'?", src, re.M))
    arts = {}
    for chunk in re.split(r'\n#{5} ', src)[1:]:
        m = re.match(r'제(\d+)조(?:의(\d+))?\s*\(([^)]*)\)', chunk)
        if not m:
            continue
        body = chunk.split('\n#')[0]
        body = re.sub(r'\*\*', '', body)            # **①** → ①
        body = body.replace('\\.', '.')              # 1\. → 1.
        body = re.sub(r'\s+', ' ', body).strip()
        body = re.sub(r'^제(\d+)조(의\d+)?\s*\(', r'제\1조\2(', body)   # '제1조 (목적)' → '제1조(목적)'
        arts[(int(m.group(1)), int(m.group(2) or 0))] = (m.group(3), body)
    return head, arts

def main():
    kb_path, md_path, law_key, *targets = sys.argv[1:]
    head, arts = parse_md(md_path)
    kb = json.load(open(kb_path, encoding='utf-8'))
    law = kb['laws'][law_key]
    done = []
    for t in targets:
        jo, _, ui = t.partition('의')
        key = (int(jo), int(ui or 0))
        if key not in arts:
            sys.exit(f'원문에 없는 조문: {t}')
        title, text = arts[key]
        for a in law['articles']:
            if (a['jo'], a['ui']) == key:
                a['title'], a['text'] = title, text
                a.pop('bad', None)
                done.append(t)
                break
        else:
            sys.exit(f'KB에 없는 조문: {t}')
    meta = kb.setdefault('meta', {})
    meta['알려진문제'] = [p for p in meta.get('알려진문제', []) if not any(f'{law_key} 제{d}조' in p for d in done)]
    note = f"{law['name']} 제{'·'.join(done)}조 원문 복구(공포 {head.get('공포번호','?')}, 시행 {head.get('시행일자','?')})"
    meta['보정'] = (meta.get('보정', '') + ' / ' if meta.get('보정') else '') + note
    json.dump(kb, open(kb_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('복구:', note)

if __name__ == '__main__':
    main()
