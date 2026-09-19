// test_retrieve.js — 법령 검색 회귀 테스트 (v92 구 로직 vs v93 신 로직)
// 사용: node test_retrieve.js [worker.js]   (인자 생략 시 law_block.js)
// worker.js 안의 LAW_RETRIEVAL_BEGIN~END 구간을 그대로 실행하므로, 배포 파일과 테스트 대상이 항상 동일하다.
const fs = require('fs');
const path = require('path');
const ROOT = process.env.APP_DIR || path.join(__dirname, '..');

const target = process.argv[2] || path.join(ROOT, 'worker.js');
const src = fs.readFileSync(target, 'utf8');
const region = src.slice(src.indexOf('// ── LAW_RETRIEVAL_BEGIN'), src.indexOf('// ── LAW_RETRIEVAL_END'));
if (!region) throw new Error('LAW_RETRIEVAL 마커를 찾지 못했습니다: ' + target);
// KB 경로: 기본은 저장소 루트의 law_kb.json. 환경변수 KB로 바꿀 수 있다.
// KB_OLD를 주면 v92 로직을 그 구버전 KB로 돌려 신·구를 비교한다(없으면 같은 KB로 비교).
const KBFILE = process.env.KB || path.join(ROOT, 'law_kb.json');
const kb = JSON.parse(fs.readFileSync(KBFILE, 'utf8'));
const kbOld = JSON.parse(fs.readFileSync(process.env.KB_OLD || KBFILE, 'utf8'));

// ── v92 구 로직 (worker.js v92 원본 그대로) ──
const OLD = (() => {
  const LAW_SCORE_MIN = 6;
  const LAW_FORCE = ['과태료','벌칙','처벌','위반','법적','의무','산안법','산업안전보건법'];
  const LAW_SYN = {
    '폭염':['고열','고온','온열'],'온열질환':['고열','열사병','열탈진','열경련'],'열사병':['고열','열탈진'],
    '더위':['고열','고온'],'온도':['고열','한랭'],'휴식':['휴게'],
    '추락':['떨어짐','안전대','안전난간','개구부','작업발판'],'떨어짐':['추락','안전대'],'사다리':['이동식'],
    '비계':['가설','발판','달비계'],'고소작업':['추락','안전대'],
    '끼임':['협착','방호','말림'],'프레스':['방호장치','금형','전단기','슬라이드'],'전단기':['방호장치','프레스'],
    '컨베이어':['건널다리','덮개','비상정지'],'롤러':['급정지장치','말림'],'둥근톱':['날접촉예방','반발예방','목재가공'],
    '목재가공':['둥근톱','대패','모떼기'],'원심기':['덮개','운전정지'],
    '연삭':['숫돌','덮개','그라인더'],'그라인더':['연삭','숫돌','덮개'],
    '용접':['용단','불티','화기','가스용접','아크'],'용단':['용접','불티'],
    '지게차':['차량계','하역','운반기계','좌석안전띠'],'크레인':['양중','달기','훅','와이어로프','방호장치'],
    '중량물':['인력','취급','요통'],'하역':['차량계','운반'],
    '감전':['전기','접지','누전차단기','충전부','정전'],'전기':['감전','접지','충전부'],
    '화재':['인화성','점화원','환기','방화'],'폭발':['인화성','가스','환기','방폭'],
    '화학물질':['관리대상','유해','msds','경고표시'],'유해물질':['관리대상','국소배기','보호구'],
    '밀폐공간':['질식','산소','환기','유해가스'],'질식':['밀폐','산소','환기'],
    '분진':['호흡','마스크','국소배기'],'소음':['청력','난청','보호구'],'진동':['국소진동','공구'],
    '로토':['잠금','표지','정비','방호'],'loto':['잠금','표지','정비'],'잠금':['표지','정비'],
    '보호구':['지급','착용'],'사망':['중대재해','산업재해']
  };
  function lawExpand(q) {
    const base = q.replace(/[^가-힣A-Za-z0-9 ]/g, ' ').toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    const set = new Set(base);
    for (const t of base) { if (LAW_SYN[t]) LAW_SYN[t].forEach(s => set.add(s)); for (const k in LAW_SYN) if (t.includes(k)) LAW_SYN[k].forEach(s => set.add(s)); }
    return [...set];
  }
  function lawRetrieve(kb, q, n = 3) {
    const terms = lawExpand(q); const out = [];
    for (const lk in kb.laws) { const law = kb.laws[lk];
      for (const a of law.articles) { let sc = 0, h = 0;
        for (const t of terms) { if (a.title && a.title.toLowerCase().includes(t)) { sc += 5; h++; } else if (a.text.toLowerCase().includes(t)) { sc += 1; h++; } }
        if (sc > 0) { sc += h * 2; out.push({ lawName: law.name, jo: a.jo, ui: a.ui, title: a.title, text: a.text, score: sc }); }
      } }
    out.sort((x, y) => y.score - x.score); return out.slice(0, n);
  }
  return { run(q) { const m = lawRetrieve(kbOld, q, 3); const top = m[0]?.score || 0;
    const forced = LAW_FORCE.some(k => q.includes(k)) || /제\s*\d+\s*조/.test(q);
    return { matched: m, active: !!(m.length && (forced || top >= LAW_SCORE_MIN)) }; } };
})();

// ── v93 신 로직 (대상 파일의 마커 구간을 그대로 실행) ──
const NEW = new Function('kb', region + `
  return { run(q) { const m = lawRetrieve(kb, q); const top = m[0]?.score || 0;
    const direct = m.some(x => x.direct);
    const forced = LAW_FORCE.some(k => q.includes(k)) || /제\\s*\\d+\\s*조/.test(q);
    return { matched: m, active: !!(m.length && (direct || top >= LAW_SCORE_MIN || (forced && top >= LAW_SCORE_MIN / 2))) }; } };
`)(kb);

// ── 테스트 질문: [질문, 정답 조문(any-of) 'lawName 제N조' 형식] ──
const L = '산업안전보건법', D = '산업안전보건법 시행령', R = '산업안전보건법 시행규칙', K = '산업안전보건기준에 관한 규칙';
const CASES = [
  ['산업재해조사표는 언제제출해야해?', [`${R} 제73조`]],
  ['중대재해 발생하면 언제까지 보고해야 하나요', [`${R} 제67조`, `${L} 제54조`]],
  ['산재 나면 며칠안에 신고해야돼?', [`${R} 제73조`, `${R} 제67조`]],
  ['안전보건교육 시간은 얼마나 되나요', [`${R} 제26조`, `${L} 제29조`]],
  ['신입 직원 안전교육 몇시간 해야해요', [`${R} 제26조`, `${L} 제29조`]],
  ['안전관리자는 몇명이상 사업장에서 선임해야하나요', [`${D} 제16조`, `${L} 제17조`]],
  ['관리감독자 업무가 뭐야', [`${D} 제15조`, `${L} 제16조`, `${K} 제35조`]],
  ['위험성평가는 언제 실시하나요', [`${R} 제37조`, `${L} 제36조`]],
  ['밀폐공간 작업할때 산소농도 기준이 뭐야', [`${K} 제619조`, `${K} 제620조`, `${K} 제618조`]],
  ['지게차 운전할 때 안전띠 매야하나요', [`${K} 제183조`]],
  ['폭염에 휴식시간 얼마나 줘야해', [`${K} 제562조`, `${K} 제566조`]],
  ['추락 위험 있는 곳 안전난간 설치 기준', [`${K} 제13조`, `${K} 제42조`]],
  ['개구부에 덮개 설치해야 하나요', [`${K} 제43조`]],
  ['물질안전보건자료 게시해야 하나요', [`${L} 제114조`, `${L} 제110조`]],
  ['MSDS 교육도 해야돼?', [`${L} 제114조`, `${L} 제110조`]],
  ['작업환경측정은 얼마나 자주 해야하나요', [`${R} 제190조`, `${L} 제125조`]],
  ['특수건강진단 대상이 누구야', [`${L} 제130조`, `${R} 제202조`, `${R} 제201조`]],
  ['휴게시설 설치 의무 사업장은?', [`${L} 제128조의2`, `${D} 제96조의2`, `${R} 제194조의2`]],
  ['안전모 안 쓰면 과태료 있나요', [`${L} 제175조`, `${K} 제32조`]],
  ['프레스 작업 방호장치 뭐 달아야해', [`${K} 제103조`]],
  ['용접할 때 화재감시자 배치해야하나요', [`${K} 제241조의2`, `${K} 제241조`]],
  ['크레인 작업 시 조치사항', [`${K} 제146조`]],
  ['누전차단기 설치 기준', [`${K} 제304조`]],
  ['산업재해 기록은 몇년 보존해야 하나요', [`${R} 제72조`]],
  ['근로자가 위험하면 작업중지 할 수 있나요', [`${L} 제52조`]],
  ['안전보건관리책임자 선임 기준', [`${D} 제14조`, `${L} 제15조`]],
  ['도급인의 안전조치 의무', [`${L} 제64조`, `${L} 제65조`]],
  ['컨베이어 비상정지장치 있어야 해?', [`${K} 第192조`.replace('第','제')]],
  ['사다리 작업 기준 알려줘', [`${K} 제24조`, `${K} 제42조`]],
  ['화학물질 경고표시 어떻게 해야해', [`${L} 제115조`]],
  // ── 별표에만 수치가 있는 질문 (v95 별표 수록 후 정답 가능) ──
  ['사무직 정기교육 몇시간이야', [`${R} 별표4`]],
  ['일용근로자 채용시 교육 몇시간', [`${R} 별표4`]],
  ['관리감독자 정기교육 시간', [`${R} 별표4`]],
  ['안전보건교육 안하면 과태료 얼마야', [`${D} 별표35`]],
  ['안전관리자 선임 안하면 과태료', [`${D} 별표35`]],
  ['안전관리자 몇명 둬야해', [`${D} 별표3`]],
  ['산업안전보건위원회 구성 대상 사업장', [`${D} 별표9`]],
  ['휴게시설 면적 최소 몇 제곱미터', [`${R} 별표21의2`]],
  ['안전보건관리책임자 몇명 이상 사업장', [`${D} 별표2`]],
  ['안전보건관리규정에 뭘 넣어야 해', [`${R} 별표3`]],
  // ── 산안규칙 별표 (작업시작 전 점검 = 앱 체크리스트의 법적 근거) ──
  ['프레스 작업 시작 전 점검사항', [`${K} 별표3`]],
  ['지게차 작업 전에 뭘 점검해야 해', [`${K} 별표3`]],
  ['컨베이어 작업 전 점검사항', [`${K} 별표3`]],
  ['고소작업대 작업 시작 전 점검', [`${K} 별표3`]],
  ['작업 전에 뭘 확인해야 하나요', [`${K} 별표3`]],
  ['굴착면 기울기 기준이 어떻게 돼', [`${K} 별표11`]],
  ['밀폐공간에 해당하는 장소가 뭐야', [`${K} 별표18`, `${K} 제619조`]],
];

// v92는 {lawName,jo,ui}, v93+는 label 문자열 → 둘 다 "법령명 제N조[의M]" 또는 "법령명 별표N"으로 정규화
const key = r => r.label
  ? (r.label.match(/^(.*?) (제\d+조(?:의\d+)?|별표 \d+(?:의\d+)?)/) || []).slice(1).join(' ').replace('별표 ', '별표')
  : `${r.lawName} 제${r.jo}조${r.ui ? '의' + r.ui : ''}`;
const short = r => key(r).replace('산업안전보건기준에 관한 규칙', '산안규칙').replace('산업안전보건법 시행', '시행').replace('산업안전보건법', '법');
let oldHit = 0, newHit = 0, oldAct = 0, newAct = 0;
const rows = [];
for (const [q, exp] of CASES) {
  const o = OLD.run(q), n = NEW.run(q);
  const oh = o.active && o.matched.some(r => exp.includes(key(r)));
  const nh = n.active && n.matched.some(r => exp.includes(key(r)));
  oldHit += oh; newHit += nh; oldAct += o.active; newAct += n.active;
  rows.push(`| ${q} | ${o.active ? o.matched.map(short).join(', ') : '(미발동)'} | ${n.matched.map(short).join(', ')} | ${oh ? '✅' : '❌'} → ${nh ? '✅' : '❌'} |`);
}
console.log('| 질문 | v92 주입 | v94 주입 | 정답 |');
console.log('|---|---|---|---|');
console.log(rows.join('\n'));
console.log(`\n**법령 모드 발동**: v92 ${oldAct}/${CASES.length} → v94 ${newAct}/${CASES.length}`);
console.log(`**정답 근거 주입**: v92 ${oldHit}/${CASES.length} → v94 ${newHit}/${CASES.length}`);
process.exitCode = newHit < CASES.length ? 1 : 0;
