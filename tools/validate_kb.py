#!/usr/bin/env python3
# validate_kb.py — law_kb 배포 전 검증. 실패하면 종료코드 1 → 배포 중단.
# v92 KB가 검증 없이 배포되어 조문 오염(법 제1·40·51·63조)이 그대로 서비스된 것이 이 파일을 만든 이유다.
import json, re, sys, collections, itertools

def main(path='law_kb.v2.json'):
    kb = json.load(open(path, encoding='utf-8'))
    errs, warns, info = [], [], []
    laws = kb.get('laws', {})
    if not laws: errs.append('laws 없음'); return report(errs, warns, info)

    total_a = total_x = 0
    for lk, law in laws.items():
        arts = law.get('articles', [])
        total_a += len(arts)
        name = law.get('name', lk)

        # 1) 본문이 자기 조번호로 시작하는가 (오분할 탐지의 핵심)
        for a in arts:
            head = f"제{a['jo']}조" + (f"의{a['ui']}" if a.get('ui') else '')
            if a.get('bad'): continue
            if not a['text'].startswith(head):
                errs.append(f"{name} {head}: 본문이 '{head}'로 시작하지 않음 → 「{a['text'][:40]}…」")
            if len(a['text']) < 40:
                warns.append(f"{name} {head}({a.get('title','')}): 본문 {len(a['text'])}자로 비정상적으로 짧음")

        # 2) 제목이 본문 괄호 안 제목과 일치하는가
        for a in arts:
            if a.get('bad'): continue
            m = re.match(r'제\d+조(?:의\d+)?\(([^)]{1,60})\)', a['text'])
            if m and a.get('title') and m.group(1).replace(' ', '') != a['title'].replace(' ', ''):
                warns.append(f"{name} 제{a['jo']}조: title='{a['title']}' ≠ 본문 '{m.group(1)}'")

        # 3) 부칙 혼입 (본칙에 '시행일'·'경과조치' 제목이 오면 부칙을 본칙으로 읽은 것)
        for a in arts:
            if a.get('bad'): continue
            if a.get('title') in ('시행일', '경과조치', '적용례', '다른 법령과의 관계'):
                errs.append(f"{name} 제{a['jo']}조: 부칙으로 보이는 제목 '{a['title']}'이 본칙에 있음")
            if '부칙 <' in a['text'] or re.search(r'\[별표\s*\d+\].{0,40}\[별표\s*\d+\]', a['text']):
                errs.append(f"{name} 제{a['jo']}조: 본문에 부칙/별표 목차가 흡수됨")

        # 4) 중복 조번호
        keys = [(a['jo'], a.get('ui') or 0) for a in arts]
        for k, c in collections.Counter(keys).items():
            if c > 1: errs.append(f"{name} 제{k[0]}조{'의'+str(k[1]) if k[1] else ''}: {c}회 중복")

        # 5) 결번 (삭제 조문일 수 있으므로 경고)
        jos = sorted({a['jo'] for a in arts})
        for i in range(1, len(jos)):
            if jos[i] - jos[i-1] > 3:
                warns.append(f"{name}: 제{jos[i-1]}조 ~ 제{jos[i]}조 사이 {jos[i]-jos[i-1]-1}개 결번 (삭제 조문 여부 확인 필요)")

        # 6) 별표 참조 ↔ 수록 대조
        cited = set()
        for a in arts:
            body = re.sub(r'\[\s*별표[^\]]*\]', '', a['text'])
            for m in re.findall(r'별표\s*(\d+(?:\s*의\s*\d+)?)', body): cited.add(m.replace(' ', ''))
        have = {x['no'] for x in law.get('annexes', [])}
        total_x += len(law.get('annexes', []))
        if cited:
            info.append(f"{name}: 별표 참조 {len(cited)}종 중 수록 {len(have & cited)}종"
                        + (f" / 미수록 {sorted(cited - have, key=lambda s: [int(y) for y in s.split('의')])[:12]}" if cited - have else ''))

        # 7) 별표 청크 연속성
        for no, grp in itertools.groupby(sorted(law.get('annexes', []), key=lambda x: (x['no'], x['part'])), key=lambda x: x['no']):
            g = list(grp); parts = [x['part'] for x in g]
            if parts != list(range(1, len(parts) + 1)) or g[0]['parts'] != len(parts):
                errs.append(f"{name} 별표 {no}: 청크 번호 불연속 {parts} (parts={g[0]['parts']})")

        # 8) 공백 노이즈 잔존
        t = ' '.join(a['text'] for a in arts)
        if t.count(' .') > 20 or len(re.findall(r'제 \d', t)) > 5:
            warns.append(f"{name}: 공백 노이즈 잔존 (' .' {t.count(' .')}건, '제 N' {len(re.findall(r'제 .d', t))}건)")

    bad = [f"{l.get('name')} 제{a['jo']}조 — {a['bad']}" for l in laws.values() for a in l['articles'] if a.get('bad')]
    info.append(f"조문 {total_a:,}개 / 별표 청크 {total_x:,}개 / 오염 격리 {len(bad)}개")
    for b in bad: info.append('  격리: ' + b)
    return report(errs, warns, info)

def report(errs, warns, info):
    for i in info: print('ℹ️  ' + i)
    for w in warns: print('⚠️  ' + w)
    for e in errs: print('❌ ' + e)
    print(f"\n검증 결과 — 오류 {len(errs)} / 경고 {len(warns)}")
    if errs: print('❌ 배포 중단: 오류를 해결한 뒤 다시 빌드하세요.')
    else: print('✅ 배포 가능')
    return 1 if errs else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'law_kb.v2.json'))
