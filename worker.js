// ═══════════════════════════════════════════════════════════════════════════
//  오늘의안전 AI 프록시 (Cloudflare Worker) — v94
//  역할: 앱(GitHub Pages)과 AI API 사이의 중계. API 키·관리자 PIN은 이 Worker의 Secret에만 존재한다.
//  AI 백엔드 이중화: Groq(주, openai/gpt-oss-120b) → 실패·한도 시 Google Gemini(폴백, gemini-2.5-flash)
//    · 정상: Groq 응답 → 그대로 반환
//    · Groq 403(IP 차단)/429(한도)/5xx/빈 응답: Gemini로 자동 전환 (통계 gemini_fallback)
//    · [v93] 예측 라우팅: 직전 Groq 응답의 잔여 한도가 바닥이면 실패를 기다리지 않고 Gemini부터 호출 (통계 gemini_preroute)
//  법령 근거(RAG): law_kb.json(산안법·시행령·시행규칙·산안규칙 1,227조문)에서 질문 관련 조문을 검색해 프롬프트에 주입
//  v93 변경: ① 관리자 인증을 서버측 PIN 검증 + 세션토큰으로 전환 ② 법령 검색 정확도 개선 ③ 예측 라우팅
//  v94 변경: ④ 법령 KB 정비(별표 10종 수록·공백 정규화·파싱 오염 조문 격리) ⑤ 항 단위 주입 ⑥ 답변 조문번호 검증
// ═══════════════════════════════════════════════════════════════════════════
// 앱 도메인만 허용 (다른 사이트/스크립트의 도용 차단). 주소가 늘면 여기에 추가만 하면 됨.
// 주의: Origin은 '경로 없는' 스킴+호스트. github.io/safety/ → https://yeonskimm.github.io
const ALLOWED_ORIGINS = ['https://yeonskimm.github.io'];
const isAllowed = (o) => ALLOWED_ORIGINS.includes(o);

// Groq 차단/장애 시 폴백으로 쓰는 Google Gemini 무료 모델.
// (2.0 Flash 계열은 2026-06-01 서비스 종료됨 → 2.5-flash 사용. 무료 티어 유지 확인: 2026-06)
// 이 모델이 향후 폐지(404)되면 코드가 'gemini-flash-latest' 별칭으로 자동 1회 재시도한다.
const GEMINI_MODEL = 'gemini-2.5-flash';

// 주 AI 모델(Groq). Groq은 모델 폐지가 잦으므로 반드시 이 상수만 바꿀 것.
//  - llama-3.3-70b-versatile: 2026-08-16 종료 → openai/gpt-oss-120b 로 교체(2026-08)
//  - 무료 한도: 30 RPM / 1,000 RPD / 8K TPM / 200K TPD  (토큰이 먼저 소진되는 구조)
//  - 추론(reasoning) 모델이라 reasoning_effort·include_reasoning 파라미터를 함께 씀.
const GROQ_MODEL = 'openai/gpt-oss-120b';

// ═══════════════════ 법령 근거 모드 (KB 기반 RAG) ═══════════════════
// 법제처 직접연동은 Cloudflare 차단(520/525)으로 불가 → GitHub의 조문 JSON을 받아 캐시 후 검색.
// [v93] 조사·어미 제거, IDF 가중, 문서명 직결 사전으로 검색 정확도 개선
// [v94] ① 항(①②③) 단위 주입 — 긴 조문이 잘려 뒷부분이 사라지던 문제 해결
//       ② 별표 수록 — 교육시간·선임기준·과태료 금액은 조문이 아니라 별표에 있어, 전에는 근거 없이 답했다
//       ③ 답변 검증(lawVerify) — 주입한 근거에 없는 조문번호를 AI가 지어내면 표기를 떼고 경고를 붙인다
// ── LAW_RETRIEVAL_BEGIN ── (test_retrieve.js가 이 구간을 그대로 읽어 검증한다. 마커를 지우지 말 것)
const LAW_KB_URL = 'https://yeonskimm.github.io/safety/law_kb.json';
const LAW_MAX_ARTICLES = 4;    // 주입 단위 수 (v95: 항 단위 선별로 개수를 늘림)
const LAW_BUDGET = 3200;       // 법령 근거 전체 글자 예산 (Groq 무료 8K TPM 고려)
const LAW_SLICE = 1100;        // 단위 1건당 최대 글자
const LAW_SCORE_MIN = 8;       // IDF 가중 점수 기준. 실측: 정상 질문 12~54점, 잡담·무관 질문 ≤6점
const LAW_FORCE = ['과태료','벌칙','처벌','위반','법적','의무','산안법','산업안전보건법','법령','조항','규정'];   // ('기준'은 일상어라 제외)

// 문서명·용어 → 조문/별표 직결. 값은 '법령키:조[-의]' 또는 '법령키:별표N'
//   (법령키: sanan_law 법 / sanan_decree 시행령 / sanan_rule 시행규칙 / kijun_rule 산안규칙)
// ※ 키는 공백 제거·소문자 기준으로 질문에 '포함'되면 적용. 2글자 단독 키는 오검색 위험이 있어 넣지 않는다.
//    '산재+신고'처럼 '+'로 이은 키는 두 단어가 모두 있을 때만 적용(짧은 단어의 조합 판정용).
const LAW_DIRECT = {
  // 복합키 — 재해 보고 계열 (가장 자주 틀렸던 영역)
  '산재+신고': ['sanan_rule:73', 'sanan_rule:67'], '산재+보고': ['sanan_rule:73', 'sanan_rule:67'], '산재+제출': ['sanan_rule:73'],
  '재해+신고': ['sanan_rule:73', 'sanan_rule:67'], '재해+보고': ['sanan_rule:73', 'sanan_rule:67'], '사고+신고': ['sanan_rule:73', 'sanan_rule:67'],
  '사망+보고': ['sanan_rule:67', 'sanan_law:54'], '사망+신고': ['sanan_rule:67', 'sanan_law:54'], '재해+기록': ['sanan_rule:72'], '재해+보존': ['sanan_rule:72'],
  // 교육시간·교육내용은 조문이 아니라 별표에 수치가 있다 → 별표를 함께 건다
  '교육시간': ['sanan_rule:별표4', 'sanan_rule:26'], '교육몇시간': ['sanan_rule:별표4'], '몇시간교육': ['sanan_rule:별표4'],
  '정기교육': ['sanan_rule:별표4', 'sanan_rule:26'], '채용시교육': ['sanan_rule:별표4'], '특별교육': ['sanan_rule:별표4', 'sanan_rule:별표5'],
  '교육내용': ['sanan_rule:별표5', 'sanan_rule:26'], '교육과정': ['sanan_rule:별표4'],
  '안전보건교육': ['sanan_law:29', 'sanan_rule:26', 'sanan_rule:별표4'], '안전교육': ['sanan_law:29', 'sanan_rule:26', 'sanan_rule:별표4'],
  '기초안전보건교육': ['sanan_law:31', 'sanan_rule:별표4'], '직무교육': ['sanan_law:32', 'sanan_rule:29', 'sanan_rule:별표4'],
  // 보고·기록 서식
  '산업재해조사표': ['sanan_rule:73'], '재해조사표': ['sanan_rule:73'], '산재조사표': ['sanan_rule:73'],
  '산업재해발생보고': ['sanan_rule:73'], '재해발생보고': ['sanan_rule:73'], '사고보고': ['sanan_rule:73', 'sanan_rule:67'],
  '중대재해보고': ['sanan_rule:67'], '중대재해발생': ['sanan_rule:67', 'sanan_law:54'],
  '산업재해기록': ['sanan_rule:72'], '재해기록': ['sanan_rule:72'],
  // 안전보건관리체제 — 선임 기준 수치는 시행령 별표에 있다
  '안전보건관리책임자': ['sanan_law:15', 'sanan_decree:14', 'sanan_decree:별표2'],
  '관리감독자': ['sanan_law:16', 'sanan_decree:15', 'kijun_rule:35'],
  '안전관리자': ['sanan_law:17', 'sanan_decree:16', 'sanan_decree:별표3'], '안전관리자선임': ['sanan_decree:별표3', 'sanan_decree:16'],
  '보건관리자': ['sanan_law:18', 'sanan_decree:20', 'sanan_decree:22'],
  '안전보건관리담당자': ['sanan_law:19', 'sanan_decree:24'],
  '산업안전보건위원회': ['sanan_law:24', 'sanan_decree:34', 'sanan_decree:별표9'],
  '명예산업안전감독관': ['sanan_law:23', 'sanan_decree:32'],
  '안전보건관리규정': ['sanan_law:25', 'sanan_rule:25', 'sanan_rule:별표3'],
  '안전보건개선계획': ['sanan_law:49', 'sanan_law:50'],
  // 평가·측정·건강
  '위험성평가': ['sanan_law:36', 'sanan_rule:37'], '작업환경측정': ['sanan_law:125', 'sanan_rule:186', 'sanan_rule:190'],
  '측정주기': ['sanan_rule:190'], '일반건강진단': ['sanan_law:129'], '특수건강진단': ['sanan_law:130', 'sanan_rule:202'],
  '건강진단': ['sanan_law:129', 'sanan_law:130'], '건강검진': ['sanan_law:129', 'sanan_law:130'],
  '물질안전보건자료': ['sanan_law:110', 'sanan_law:114'], 'msds': ['sanan_law:110', 'sanan_law:114'],
  '경고표시': ['sanan_law:115'], '유해위험방지계획서': ['sanan_law:42', 'sanan_decree:42'],
  '유해성위험성분류': ['sanan_rule:별표18'],
  // 시설·표지·휴게
  '휴게시설': ['sanan_law:128-2', 'sanan_rule:별표21의2', 'sanan_decree:96-2'], '휴게시설기준': ['sanan_rule:별표21의2'],
  '안전보건표지': ['sanan_law:37', 'sanan_rule:38'], '비상구': ['kijun_rule:17', 'kijun_rule:18'],
  // 사업주·근로자 의무, 작업중지, 도급
  '사업주의무': ['sanan_law:5', 'sanan_law:38', 'sanan_law:39'], '근로자의무': ['sanan_law:6'],
  '작업중지': ['sanan_law:52', 'sanan_law:55'],   // ('안전조치'·'보건조치'는 너무 일반적이라 직결하지 않음 — 검색에 맡김)
  '도급인': ['sanan_law:64', 'sanan_law:65'], '하도급': ['sanan_law:58', 'sanan_law:60'],
  // 벌칙·과태료 — 금액은 시행령 별표35에만 있다
  '과태료': ['sanan_decree:별표35', 'sanan_law:175'], '과태료얼마': ['sanan_decree:별표35'], '과태료금액': ['sanan_decree:별표35'],
  '부과기준': ['sanan_decree:별표35'], '벌금': ['sanan_law:167', 'sanan_law:168', 'sanan_law:170'], '징역': ['sanan_law:167', 'sanan_law:168'],
  // 산안규칙 별표 3 — 작업시작 전 점검사항 (앱 체크리스트의 법적 근거)
  '작업시작전점검': ['kijun_rule:별표3', 'kijun_rule:35'], '작업전점검': ['kijun_rule:별표3', 'kijun_rule:35'],
  '작업전+확인': ['kijun_rule:별표3'], '작업전+점검': ['kijun_rule:별표3'], '작업시작+점검': ['kijun_rule:별표3'], '시작전+확인': ['kijun_rule:별표3'],
  '시작전점검': ['kijun_rule:별표3'], '점검사항': ['kijun_rule:별표3'], '작업전확인': ['kijun_rule:별표3'],
  '일상점검': ['kijun_rule:별표3'], '시업점검': ['kijun_rule:별표3'],
  // 산안규칙 — 굴착·밀폐공간 수치 기준
  '굴착면기울기': ['kijun_rule:별표11', 'kijun_rule:339'], '기울기기준': ['kijun_rule:별표11'],
  '굴착기울기': ['kijun_rule:별표11'], '법면': ['kijun_rule:별표11', 'kijun_rule:339'],
  '밀폐공간해당': ['kijun_rule:별표18'], '밀폐공간범위': ['kijun_rule:별표18'], '밀폐공간종류': ['kijun_rule:별표18'],
  // 산안규칙 — 추락·개구부·통로
  '추락방지': ['kijun_rule:42', 'kijun_rule:44'], '안전난간': ['kijun_rule:13', 'kijun_rule:42'], '개구부': ['kijun_rule:43'],
  '안전대': ['kijun_rule:44', 'kijun_rule:32'], '작업발판': ['kijun_rule:56', 'kijun_rule:9'], '사다리': ['kijun_rule:24', 'kijun_rule:42'],
  '낙하물': ['kijun_rule:14'], '통로': ['kijun_rule:22', 'kijun_rule:21'],
  // 산안규칙 — 기계·설비
  '지게차': ['kijun_rule:183', 'kijun_rule:180', 'kijun_rule:178', 'kijun_rule:별표3'], '좌석안전띠': ['kijun_rule:183'], '헤드가드': ['kijun_rule:180'],
  '프레스': ['kijun_rule:103', 'kijun_rule:별표3'], '크레인': ['kijun_rule:146', 'kijun_rule:139', 'kijun_rule:별표3'], '타워크레인': ['kijun_rule:142', 'kijun_rule:146'],
  '컨베이어': ['kijun_rule:191', 'kijun_rule:192', 'kijun_rule:별표3'], '둥근톱': ['kijun_rule:105', 'kijun_rule:106'],
  '연삭기': ['kijun_rule:122'], '그라인더': ['kijun_rule:122'], '보호구': ['kijun_rule:32', 'kijun_rule:33'],
  '안전모': ['kijun_rule:32'], '안전화': ['kijun_rule:32'],
  // 산안규칙 — 전기·화재·화학
  '누전차단기': ['kijun_rule:304'], '감전': ['kijun_rule:304', 'kijun_rule:301'], '접지': ['kijun_rule:302'],
  '화재감시자': ['kijun_rule:241-2'], '화기작업': ['kijun_rule:241', 'kijun_rule:241-2'], '용접': ['kijun_rule:241', 'kijun_rule:233'],
  '인화성': ['kijun_rule:231', 'kijun_rule:232'], '밀폐공간': ['kijun_rule:619', 'kijun_rule:620', 'kijun_rule:별표18'],
  '산소농도': ['kijun_rule:620', 'kijun_rule:619'], '질식': ['kijun_rule:619', 'kijun_rule:620'],
  // 산안규칙 — 환경·인간공학
  '폭염': ['kijun_rule:562', 'kijun_rule:566'], '온열질환': ['kijun_rule:562', 'kijun_rule:566'], '고열작업': ['kijun_rule:559', 'kijun_rule:566'],
  '한랭': ['kijun_rule:563'], '소음': ['kijun_rule:513', 'kijun_rule:514'], '분진': ['kijun_rule:614', 'kijun_rule:4-2'],
  '중량물': ['kijun_rule:385', 'kijun_rule:663'], '근골격계': ['kijun_rule:657', 'kijun_rule:659'],
  '조명': ['kijun_rule:7', 'kijun_rule:21'], '정리정돈': ['kijun_rule:3', 'kijun_rule:9'],
  // 건설
  '비계': ['kijun_rule:57', 'kijun_rule:58'], '달비계': ['kijun_rule:63'], '굴착': ['kijun_rule:338', 'kijun_rule:340', 'kijun_rule:별표11'],
};

// [v93 발견] law_kb 파싱 오류 조문 — KB v2가 bad 표시를 달고 오지만, 구버전 KB를 받아도 막히도록 이중 방어.
const LAW_EXCLUDE = new Set(['산업안전보건법|1|0', '산업안전보건법|40|0', '산업안전보건법|51|0', '산업안전보건법|63|0', '산업안전보건기준에 관한 규칙|2|0']);

// 동의어: 질문 단어 → 조문에 쓰이는 표현. (검색 확장용, 가중치는 본 단어의 60%)
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
  '보호구':['지급','착용'],'사망':['중대재해','산업재해'],
  '안전교육':['안전보건교육'],'교육':['안전보건교육'],'검진':['건강진단'],'건강검진':['건강진단'],
  '산재':['산업재해'],'사고':['산업재해','중대재해'],'신고':['보고'],'제출':['보고'],
  '기한':['이내'],'언제까지':['이내'],'며칠':['이내'],'몇일':['이내'],
  '벌금':['벌칙'],'처벌':['벌칙'],'얼마':['과태료'],'금액':['과태료'],
};
// 약어·줄임말 → 조문 표기 (동의어와 달리 본 단어와 같은 가중치)
const LAW_ALIAS = { '산재':'산업재해', 'msds':'물질안전보건자료', '산안법':'산업안전보건법', '위평':'위험성평가', '작환측':'작업환경측정', '특검':'특수건강진단', '안관자':'안전관리자', '보관자':'보건관리자' };
// 불용어: 조문 어디에나 있어 판별력이 없는 말. 가중치 0.25, 제목 가산 없음
const LAW_STOP = new Set(['작업','확인','안전','보건','사업장','근로자','사업주','방법','경우','관련','사항','조치','기준','규정','내용','오늘','내일','우리','저희','회사','현장',
  '사람','직원','하는','되는','있는','없는','오는','가는','같은','이런','저런','그런','너무','정말','진짜','제발','부탁','궁금','알려','알려줘','설명','질문','대해','대한','관해','관한',
  '해야','하나','되나','있나','없나','인가','뭐야','뭐예요','무엇','필요','가능','사용','실시','설치','해도','되요','되죠','있어','없어','있음','없음','정도','이상','이하','때문']);
// 영어 질문 → 조문 검색용 한국어 키워드 (EN 모드). 영어 원문 토큰은 검색에 쓰지 않는다(KB가 한국어).
const LAW_EN = [['accident report','산업재해조사표'],['industrial accident','산업재해'],['serious accident','중대재해'],['fatal','사망'],['death','사망'],['report','보고'],['submit','제출'],['deadline','기한'],
  ['forklift','지게차'],['seat belt','좌석안전띠'],['crane','크레인'],['press','프레스'],['conveyor','컨베이어'],['grinder','연삭기'],['ladder','사다리'],['scaffold','비계'],['fall','추락'],['guardrail','안전난간'],['opening','개구부'],
  ['safety training','안전보건교육'],['safety education','안전보건교육'],['training','안전보건교육'],['education','안전보건교육'],['training hours','교육시간'],['risk assessment','위험성평가'],['msds','물질안전보건자료'],['chemical','화학물질'],['warning label','경고표시'],
  ['confined space','밀폐공간'],['oxygen','산소농도'],['heat','폭염'],['hot','고열작업'],['cold','한랭'],['rest','휴식'],['break','휴식'],['noise','소음'],['dust','분진'],['heavy','중량물'],['lifting','중량물'],
  ['helmet','안전모'],['hard hat','안전모'],['safety shoes','안전화'],['ppe','보호구'],['protective equipment','보호구'],['harness','안전대'],['welding','용접'],['fire watch','화재감시자'],['fire','화재'],['electric','감전'],['shock','감전'],['grounding','접지'],
  ['penalty','벌칙'],['fine','과태료'],['health check','건강진단'],['medical exam','건강진단'],['work environment measurement','작업환경측정'],['supervisor','관리감독자'],['safety manager','안전관리자'],['stop work','작업중지'],['refuse','작업중지'],
  ['contractor','도급인'],['subcontract','하도급'],['rest area','휴게시설'],['lockout','loto'],['tagout','loto']];

// ── 한국어 정규화: 어미(긴 것 먼저) → 조사 → 의문사 순으로 벗겨낸다 ──
const LAW_ENDINGS = ['해야하나요','해야되나요','해야합니까','해야됩니까','해야하는지','해야되는지','해야할까요','해야해요','해야돼요','해야하죠',
  '하나요','되나요','합니까','됩니까','인가요','일까요','할까요','될까요','하는지','되는지','인지요','한가요','된가요',
  '해야해','해야돼','해야함','해야','해요','돼요','하죠','되죠','이에요','예요','입니다','습니다','인가','한가','된가',
  '하면','되면','이면','하고','되고','이고','하니','되니','이야','이다','하다','되다','한다','된다','인지','까지','부터',
  '할때','될때','할땐','하며','되며','하자','되자','해','돼','함','됨','임','요','죠','까'];
const LAW_PARTICLES = ['에서는','에게는','으로는','으로써','으로서','에서','에게','께서','으로','이랑','이나','라도','이라도','조차','밖에','마다','처럼','보다','부터','까지',
  '은','는','이','가','을','를','의','에','로','와','과','랑','도','만','나','든'];
const LAW_QWORDS = ['어느정도','어디에서','어디서','어디에','어떻게','얼마나','무엇을','언제','어디','누가','누구','무엇','어떤','어느','얼마','뭘','뭐','왜','몇'];
function lawStrip(tok) {
  let t = tok;
  for (let pass = 0; pass < 2; pass++) {
    const e = LAW_ENDINGS.find(x => t.length > x.length + 1 && t.endsWith(x)); if (e) t = t.slice(0, -e.length);
    const p = LAW_PARTICLES.find(x => t.length > x.length + 1 && t.endsWith(x)); if (p) t = t.slice(0, -p.length);
    const q = LAW_QWORDS.find(x => t.length > x.length + 1 && t.startsWith(x)); if (q) t = t.slice(q.length);
  }
  return t;
}
function lawEnToKo(q) {   // 영어 구절을 한국어 키워드로 치환한 문자열 (긴 구절 우선, 단어 경계 필수)
  let out = ' '; const ql = q.toLowerCase();
  for (const [en, ko] of LAW_EN) if (new RegExp('\\b' + en + '\\b').test(ql)) out += ko + ' ';
  return out;
}
function lawExpand(q) {
  const hasLatin = /[A-Za-z]{3,}/.test(q);
  const src = hasLatin ? q + lawEnToKo(q) : q;
  const raw = src.replace(/[^가-힣A-Za-z0-9 ]/g, ' ').toLowerCase().split(/\s+/)
    .filter(t => t.length >= 2 && !/^\d/.test(t))                       // 숫자 토큰은 '제181조' 등에 오매칭되므로 제외
    .filter(t => !/^[a-z]+$/.test(t) || LAW_ALIAS[t] || LAW_SYN[t]);     // 영어 토큰은 별칭(msds·loto)만 통과
  const terms = new Map();                    // term → weight (본 단어 1.0, 동의어 0.6, 불용어 0.25)
  const add = (t, w) => { if (t && t.length >= 2 && !LAW_QWORDS.includes(t)) terms.set(t, Math.max(terms.get(t) || 0, LAW_STOP.has(t) ? Math.min(w, 0.25) : w)); };
  for (const r of raw) {
    const s = lawStrip(r); add(s, 1);
    if (LAW_ALIAS[s]) add(LAW_ALIAS[s], 1);
    if (s !== r && !LAW_STOP.has(s)) add(r, 0.5);
    for (const k in LAW_SYN) if (s === k || (s.length >= 3 && s.includes(k))) LAW_SYN[k].forEach(x => add(x, 0.6));
  }
  return terms;
}

// ── 검색 단위 만들기: 조문은 항(①②③)으로, 별표는 이미 청크로 나뉘어 있다 ──
// 긴 조문을 통째로 넣으면 900자에서 잘려 뒷부분이 사라진다. 항 단위로 쪼개 관련 항만 넣으면
// 같은 토큰으로 더 많은 조문을 담을 수 있다. (v95)
function lawUnits(kb) {
  if (kb.__units) return kb.__units;
  const units = [];
  for (const lk in kb.laws) {
    const law = kb.laws[lk];
    for (const a of law.articles) {
      const id = `${law.name}|${a.jo}|${a.ui || 0}`;
      if (a.bad || LAW_EXCLUDE.has(id)) continue;      // 파싱 오염 조문은 검색 대상에서 제외
      const label = `${law.name} 제${a.jo}조${a.ui ? '의' + a.ui : ''}(${a.title})`;
      const segs = a.text.split(/(?=[①-⑳])/).map(s => s.trim()).filter(Boolean);
      if (segs.length <= 1 || a.text.length <= LAW_SLICE) {
        units.push({ id, label, title: a.title || '', text: a.text, art: id, hang: 0 });
      } else {
        const head = /^제\d/.test(segs[0]) ? segs[0] : '';      // "제N조(제목)" 머리말 (①이 없는 선두 조각)
        segs.forEach((s, i) => {
          const n = (s.match(/^[①-⑳]/) || [''])[0];
          if (!n) return;                                      // 머리말 단독 조각은 검색 단위가 아니다
          units.push({ id: id + '|h' + i, label: label + (n ? ` ${n}` : ''), title: a.title || '',
                       text: (n && head ? head.split(/[①-⑳]/)[0].trim() + ' ' : '') + s, art: id, hang: i });
        });
      }
    }
    for (const x of (law.annexes || [])) {
      if ((x.text || '').length < 60) continue;                // 표 머리글만 담긴 청크는 근거가 못 된다
      const label = `${law.name} 별표 ${x.no}(${x.title})` + (x.parts > 1 ? ` ${x.part}/${x.parts}` : '');
      units.push({ id: `${law.name}|별표${x.no}|${x.part}`, label, title: x.title + ' ' + (x.head || ''),
                   text: x.text, art: `${law.name}|별표${x.no}`, annex: true });
    }
  }
  try { Object.defineProperty(kb, '__units', { value: units, enumerable: false }); } catch (e) {}
  return units;
}
function lawFindUnits(kb, ref) {
  const [lk, tail] = ref.split(':');
  const law = kb.laws[lk]; if (!law) return [];
  const units = lawUnits(kb);
  if (tail.startsWith('별표')) {
    const no = tail.slice(2);
    return units.filter(u => u.annex && u.art === `${law.name}|별표${no}`);
  }
  const [jo, ui] = tail.split('-').map(Number);
  const art = `${law.name}|${jo}|${ui || 0}`;
  return units.filter(u => u.art === art);
}
function lawRetrieve(kb, q, n = LAW_MAX_ARTICLES) {
  const qn = (/[A-Za-z]{3,}/.test(q) ? q + lawEnToKo(q) : q).replace(/\s+/g, '').toLowerCase();
  const terms = lawExpand(q);
  const units = lawUnits(kb);
  // IDF 계산 (질문에 나온 단어에 대해서만)
  const N = units.length, idf = new Map();
  for (const [t] of terms) { let df = 0; for (const u of units) if (u.text.toLowerCase().includes(t)) df++; if (df) idf.set(t, Math.log(1 + N / df)); }
  const scoreOf = (u) => {
    const tl = u.title.toLowerCase(), xl = u.text.toLowerCase(); let sc = 0, hits = 0;
    for (const [t, w] of terms) { const f = idf.get(t); if (!f) continue;
      if (tl.includes(t) && !LAW_STOP.has(t)) { sc += f * w * 3; hits++; } else if (xl.includes(t)) { sc += f * w; hits++; } }
    return hits ? sc + hits / terms.size : 0;
  };
  const out = [], seenArt = new Set(), seenId = new Set();
  const push = (u, sc, direct) => {
    if (seenId.has(u.id)) return; seenId.add(u.id); seenArt.add(u.art);
    out.push({ ...u, score: sc, direct });
  };
  // ① 직결 사전 (긴 키 우선). 여러 항·청크가 딸린 경우 질문과 가장 맞는 것 1개만.
  const dkeys = Object.keys(LAW_DIRECT).filter(k => k.split('+').every(p => qn.includes(p))).sort((a, b) => b.length - a.length);
  for (const k of dkeys) for (const ref of LAW_DIRECT[k]) {
    const us = lawFindUnits(kb, ref); if (!us.length) continue;
    // 여러 항·청크가 딸린 경우: 점수 최상위를 쓰되, 점수가 0이면(질문 단어가 그 별표 어디에도 없을 때)
    // 첫 청크(표 머리·총괄)로 떨어뜨린다. 목록형 별표에서 엉뚱한 꼬리 청크가 잡히는 것을 막는다.
    let best = us[0];
    if (us.length > 1) {
      const ranked = us.map(u => ({ u, s: scoreOf(u) })).sort((a, b) => b.s - a.s);
      best = ranked[0].s > 0 ? ranked[0].u : us[0];
    }
    push(best, 100 - out.length, true);
    if (out.length >= n) break;
  }
  // ② IDF 검색으로 남은 자리 채우기 (같은 조문의 다른 항은 중복 방지)
  if (out.length < n && terms.size) {
    const scored = [];
    for (const u of units) { if (seenId.has(u.id)) continue; const s = scoreOf(u); if (s > 0) scored.push({ u, s }); }
    scored.sort((a, b) => b.s - a.s);
    const hasDirect = out.some(o => o.direct);
    const fillMin = hasDirect ? LAW_SCORE_MIN * 2.5 : LAW_SCORE_MIN;   // 직결로 이미 답이 있으면 어중간한 조문은 토큰만 먹는다
    for (const { u, s } of scored) {
      if (out.length >= n) break;
      if (out.length && s < fillMin) break;
      if (seenArt.has(u.art)) continue;
      push(u, s, false);
    }
  }
  return out.slice(0, n);
}
function lawLabel(r) { return r.label; }
function lawGrounding(matched, isEn) {
  let used = 0; const parts = [];
  for (const r of matched) {
    if (used >= LAW_BUDGET) break;
    const body = r.text.slice(0, Math.min(LAW_SLICE, LAW_BUDGET - used));
    parts.push(`【${r.label}】\n${body}`); used += body.length;
  }
  const body = parts.join('\n\n');
  if (isEn) return '[Legal text — you MAY cite ONLY the articles below. Never fabricate article numbers, deadlines, amounts or content. If the answer is not in this text, say you are not certain and advise checking law.go.kr.]\n\n' + body + '\n\nEnd your answer with "📖 Source: ..." citing only the articles you used. Answer in English only.';
  return '[법령 원문 — 아래 조문·별표에 한해 정확히 인용해도 됩니다. 이 원문에 없는 조문번호·기한·금액·시간은 절대 지어내지 마세요. 원문에서 답을 못 찾으면 "확인된 조문에서 찾지 못했다"고 말하고 국가법령정보센터(law.go.kr) 확인을 안내하세요.]\n\n' + body + '\n\n답변 맨 끝에 사용한 근거를 "📖 근거: ○○ 제○조(제목)" 형식으로 표기하세요. 한자·일본어 없이 순수 한글로만 답하세요.';
}

// ── 답변 검증: 주입하지 않은 조문번호를 AI가 지어내면 경고로 바꾼다 (v95) ──
// 근거가 주입된 경우에만 동작한다. 주입 근거에 없는 "제N조"는 출처 불명이므로 문장에서 떼어내고,
// 답변 끝에 확인 안내를 붙인다. (문장 자체를 지우면 답이 무너지므로 표기만 중화한다)
function lawVerify(text, matched, isEn) {
  if (!text || !matched || !matched.length) return { text, stripped: [] };
  const allow = new Set();
  for (const r of matched) {
    if (r.annex) { allow.add('별표' + (r.label.match(/별표\s*(\d+(?:의\d+)?)/) || [])[1]); continue; }
    allow.add(`${r.jo != null ? r.jo : (r.art.split('|')[1])}|${(r.art.split('|')[2]) || 0}`);
    // 인용 조문이 본문에서 가리키는 조문(법 제N조)도 허용 — 원문에 적힌 것이므로 지어낸 게 아님
    for (const m of r.text.matchAll(/제\s*(\d+)\s*조(?:의\s*(\d+))?/g)) allow.add(`${m[1]}|${m[2] || 0}`);
  }
  const stripped = [];
  const out = text.replace(/제\s*(\d+)\s*조(?:의\s*(\d+))?(?:제\s*\d+\s*항)?/g, (full, jo, ui) => {
    if (allow.has(`${jo}|${ui || 0}`)) return full;
    stripped.push(full.trim()); return isEn ? '(the relevant provision)' : '관련 규정';
  });
  if (!stripped.length) return { text, stripped: [] };
  const note = isEn
    ? '\n\n⚠️ Some article numbers could not be verified against the retrieved legal text and were removed. Please confirm at law.go.kr.'
    : '\n\n⚠️ 일부 조문번호가 검색된 법령 원문에서 확인되지 않아 표기를 제외했습니다. 정확한 조문은 국가법령정보센터(law.go.kr)에서 확인해 주세요.';
  return { text: out + note, stripped };
}
// ── LAW_RETRIEVAL_END ──
let LAW_KB = null, LAW_KB_AT = 0;
async function getLawKB() {
  if (LAW_KB && (Date.now() - LAW_KB_AT) < 3600000) return LAW_KB;
  const res = await fetch(LAW_KB_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error('KB status ' + res.status);
  LAW_KB = await res.json(); LAW_KB_AT = Date.now();
  return LAW_KB;
}
// ════════════════════════════════════════════════════════════════════

// ═══════════════════ 고유 사용자·지역 집계 헬퍼 (v86 추가) ═══════════════════
// 시·도 명칭을 표시용으로 축약 (카카오 region_1depth_name → 짧은 이름)
const REGION_SHORT = {
  '서울특별시':'서울','부산광역시':'부산','대구광역시':'대구','인천광역시':'인천',
  '광주광역시':'광주','대전광역시':'대전','울산광역시':'울산','세종특별자치시':'세종',
  '경기도':'경기','강원특별자치도':'강원','강원도':'강원',
  '충청북도':'충북','충청남도':'충남',
  '전북특별자치도':'전북','전라북도':'전북','전라남도':'전남',
  '경상북도':'경북','경상남도':'경남','제주특별자치도':'제주'
};

// 좌표 → "대구 중구" (카카오 Local coord2regioncode). 키 없음/실패 시 빈 문자열.
async function coordToRegion(lat, lon, env) {
  if (!env.KAKAO_REST_KEY) return '';
  try {
    const u = 'https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?x='
            + encodeURIComponent(lon) + '&y=' + encodeURIComponent(lat);
    const r = await fetch(u, { headers: { 'Authorization': 'KakaoAK ' + env.KAKAO_REST_KEY } });
    if (!r.ok) return '';
    const d = await r.json();
    const docs = d.documents || [];
    const doc = docs.find(x => x.region_type === 'H') || docs[0];
    if (!doc) return '';
    const r1 = REGION_SHORT[doc.region_1depth_name] || doc.region_1depth_name || '';
    const r2 = doc.region_2depth_name || '';
    return (r1 + ' ' + r2).trim();
  } catch (e) { return ''; }
}

// KV 키 목록 페이지네이션 (이름만 수집). maxPages로 폭주 방지.
async function kvListAll(env, prefix, maxPages) {
  const names = []; let cursor; const cap = maxPages || 20;
  for (let p = 0; p < cap; p++) {
    const res = await env.STATS.list({ prefix, cursor, limit: 1000 });
    for (const k of res.keys) names.push(k.name);
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  return names;
}

// KV 값 다건 조회(JSON) — 동시성 폭주 방지를 위해 chunk 단위로 나눠 조회
async function kvGetManyJson(env, keys, chunk) {
  const size = chunk || 100; const out = [];
  for (let i = 0; i < keys.length; i += size) {
    const part = keys.slice(i, i + size);
    const vals = await Promise.all(part.map(k => env.STATS.get(k, 'json').catch(() => null)));
    for (const v of vals) out.push(v);
  }
  return out;
}
// ════════════════════════════════════════════════════════════════════════════

// ═══════════════════ 관리자 인증 (v93 — 서버측 검증) ═══════════════════
// v92까지는 PIN·토큰이 index.html에 평문으로 있어 브라우저에서 누구나 열람 가능했고 커밋 이력에도 남았다.
// v93부터 PIN은 Cloudflare Secret(ADMIN_PIN)에만 존재하고, 검증 후 HMAC 서명된 30분 세션토큰을 발급한다.
//   필요한 Secret 2개 (Cloudflare 대시보드 → Workers → safety-ai-proxy → Settings → Variables and Secrets → Add, Type=Secret):
//     ADMIN_PIN     관리자 PIN (앱 키패드가 숫자 6자리이므로 숫자 6자리)
//     ADMIN_SECRET  토큰 서명용 임의 문자열 (32자 이상 권장, 아무 문자열이나 됨)
//   둘 중 하나라도 없으면 /admin-auth 는 500 not_configured 를 돌려준다.
const ADMIN_SESSION_SEC = 30 * 60;   // 세션 유지 30분
const ADMIN_MAX_TRIES = 5;           // IP당 시간당 PIN 실패 허용 횟수 (초과 시 429)
const _enc = new TextEncoder();
const _b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const _b64uDec = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const _hmacKey = (secret) => crypto.subtle.importKey('raw', _enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
async function adminIssueToken(env) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SEC;
  const payload = _enc.encode(JSON.stringify({ exp, n: crypto.randomUUID() }));
  const sig = await crypto.subtle.sign('HMAC', await _hmacKey(env.ADMIN_SECRET), payload);
  return { token: _b64u(payload) + '.' + _b64u(sig), exp };
}
async function adminVerify(request, env) {
  try {
    if (!env.ADMIN_SECRET) return false;
    const h = request.headers.get('Authorization') || '';
    const [p, sg] = (h.startsWith('Bearer ') ? h.slice(7) : '').split('.');
    if (!p || !sg) return false;
    const payload = _b64uDec(p);
    if (!(await crypto.subtle.verify('HMAC', await _hmacKey(env.ADMIN_SECRET), _b64uDec(sg), payload))) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(payload));
    return typeof exp === 'number' && exp > Date.now() / 1000;
  } catch (e) { return false; }
}
async function safeEqual(a, b) {   // 타이밍 공격 완화: 해시끼리 고정 길이로 비교
  const [ha, hb] = await Promise.all([a, b].map(x => crypto.subtle.digest('SHA-256', _enc.encode(String(x)))));
  const ua = new Uint8Array(ha), ub = new Uint8Array(hb); let d = 0;
  for (let i = 0; i < ua.length; i++) d |= ua[i] ^ ub[i];
  return d === 0;
}
// Groq x-ratelimit-reset-* 헤더 값("2m59.56s", "7.66s", "900ms", "1h2m")을 ms로. 해석 불가면 0.
const GROQ_MIN_TOKENS = 3500;        // 요청 1건에 필요한 대략의 토큰(현재 ~3,000). 잔여가 이보다 적으면 Gemini 우선
function parseGroqDuration(v) {
  if (!v || typeof v !== 'string') return 0;
  let ms = 0, m;
  if ((m = v.match(/(\d+(?:\.\d+)?)h/))) ms += parseFloat(m[1]) * 3600000;
  if ((m = v.match(/(\d+(?:\.\d+)?)m(?!s)/))) ms += parseFloat(m[1]) * 60000;
  if ((m = v.match(/(\d+(?:\.\d+)?)ms/))) ms += parseFloat(m[1]);
  else if ((m = v.match(/(\d+(?:\.\d+)?)s/))) ms += parseFloat(m[1]) * 1000;
  return ms;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = isAllowed(origin);

    // CORS 프리플라이트 — 허용된 출처면 그 출처를 그대로 반사, 아니면 차단
    if (request.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Vary': 'Origin',
        }
      });
    }

    // 앱 도메인 외의 출처(또는 Origin 없는 스크립트) 차단
    if (!allowed) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── 앱 접속 핑 ──
    // 기존: 전체 방문 수(visits, 중복 포함) 집계 — 그대로 유지.
    // 추가(v86): POST 본문에 uid(+선택 좌표/지역)가 오면 고유 사용자·지역·기기를 추가 기록.
    //           구버전 앱(본문 없는 GET/POST)은 visits만 올라가고 그대로 통과 = 하위호환.
    if (url.pathname === '/ping') {
      // v89(이전 v88 작업): 접속(visits) 집계를 30회/인/일 상한 안쪽으로 이동 (아래 참고).
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };
      let pb = null;
      if (request.method === 'POST') { try { pb = await request.json(); } catch (e) { pb = null; } }

      // uid 없거나 형식이 아니면 visits만 1 올리고 종료 (구버전 앱 하위호환)
      const uid = pb ? String(pb.uid || '').slice(0, 40) : '';
      if (!/^[0-9a-fA-F-]{32,40}$/.test(uid)) {
        await trackStat(env, 'visits');
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }

      const kst = new Date(Date.now() + 9 * 3600 * 1000);
      const today = kst.toISOString().slice(0, 10);   // KST 기준 날짜
      const ua = request.headers.get('User-Agent') || '';
      const device = /Android/i.test(ua) ? 'Android'
                   : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : 'PC';

      // 지역 우선순위: ① 클라이언트 캐시(region) → ② 좌표→카카오 변환 → ③ IP 도시 → ④ 기타
      let region = String(pb.region || '').slice(0, 30);
      let resolvedNow = false;
      if (!region && typeof pb.lat === 'number' && typeof pb.lon === 'number'
          && pb.lat > 32 && pb.lat < 40 && pb.lon > 123 && pb.lon < 133) {
        region = await coordToRegion(pb.lat, pb.lon, env);
        resolvedNow = !!region;   // 변환 성공 시 응답에 실어 보내 클라이언트가 캐시 → 다음부턴 카카오 미호출
      }
      if (!region) {
        const city = (request.cf && request.cf.city) || '';
        region = city ? city + '(IP)' : '기타';
      }

      const vkey = `uvisit:${today}:${uid}`;
      let rec = null;
      try { rec = await env.STATS.get(vkey, 'json'); } catch (e) {}

      // 동일인 일 30회 초과 핑은 집계·기록 모두 생략 (쓰기 한도 보호 + 통계 왜곡 방지)
      if (rec && rec.n >= 30) {
        return new Response(JSON.stringify({ ok: true, region: resolvedNow ? region : undefined }), { headers: cors });
      }

      // 상한(30회/일/인) 이내 — 이 실행을 '접속(visits)'에 집계
      await trackStat(env, 'visits');

      const newRec = {
        n: ((rec && rec.n) || 0) + 1,
        region: (rec && rec.region) || region,   // 그날 첫 지역을 유지
        device,
        t: Date.now(),
      };
      try { await env.STATS.put(vkey, JSON.stringify(newRec), { expirationTtl: 365 * 86400 }); } catch (e) {}

      // 그날 첫 방문일 때만: 일별 고유 사용자 카운터 적립 + 프로필 갱신(쓰기 절약)
      if (!rec) {
        // (v91) 일별 고유 사용자 카운터 — admin-stats가 list 없이 get만으로 읽도록 미리 적립.
        //        today는 KST 날짜. uvisit 키가 uid별 하루 1개라 이 카운터 = 그날 고유 사용자 수.
        try {
          const ucKey = `ucount:${today}`;
          const uc = await env.STATS.get(ucKey);
          await env.STATS.put(ucKey, String(parseInt(uc || '0') + 1), { expirationTtl: 400 * 86400 });
        } catch (e) {}
        try {
          let prof = await env.STATS.get('uprof:' + uid, 'json');
          const isNewUser = !prof;   // 생애 첫 방문(누적 카운터 대상)
          if (!prof) prof = { first: today, days: 0 };
          prof.days = (prof.days || 0) + 1;
          prof.last = today;
          prof.region = newRec.region;
          prof.device = device;
          await env.STATS.put('uprof:' + uid, JSON.stringify(prof));   // 영구 보존(누적 통계용)
          // (v91) 누적 고유 사용자 수·지역·기기 카운터 — 생애 첫 방문 때만(쓰기·동시성 충돌 최소화)
          if (isNewUser) {
            try {
              const tu = await env.STATS.get('total:uusers');
              await env.STATS.put('total:uusers', String(parseInt(tu || '0') + 1));
            } catch (e) {}
            try {
              const rg = newRec.region || '기타';
              const reg = (await env.STATS.get('ureg:total', 'json')) || {};
              reg[rg] = (reg[rg] || 0) + 1;
              await env.STATS.put('ureg:total', JSON.stringify(reg));
            } catch (e) {}
            try {
              const dev = (await env.STATS.get('udev:total', 'json')) || {};
              dev[device] = (dev[device] || 0) + 1;
              await env.STATS.put('udev:total', JSON.stringify(dev));
            } catch (e) {}
          }
        } catch (e) {}
      }

      return new Response(JSON.stringify({ ok: true, region: resolvedNow ? region : undefined }), { headers: cors });
    }

    // ── 날씨 중계 (Worker 서버가 외부 날씨 API를 대신 호출 → 통신사 IP 차단 우회) ──
    // 앱에서 /weather?lat=..&lon=.. 로 호출. KV를 쓰지 않아 요청 한도 부담이 적음.
    // Open-Meteo와 wttr.in을 '동시에' 호출하고 먼저 성공한 응답을 사용 → 최대 속도
    // (한쪽이 죽어 있어도 다른 쪽이 살아 있으면 그 즉시 응답)
    if (url.pathname === '/weather') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };
      if (!lat || !lon) {
        return new Response(JSON.stringify({ error: 'missing lat/lon' }), { status: 400, headers: cors });
      }

      // 소스 1: Open-Meteo (성공 시 {ta,rh,ws,src} 반환, 실패 시 throw)
      const fromOpenMeteo = async () => {
        const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m`;
        const r = await fetch(omUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!r.ok) throw new Error('open-meteo ' + r.status);
        const d = await r.json();
        const c = d.current || {};
        if (c.temperature_2m == null) throw new Error('open-meteo empty');
        return { ta: c.temperature_2m, rh: c.relative_humidity_2m, ws: c.wind_speed_10m, src: 'open-meteo' };
      };

      // 소스 2: wttr.in (값이 문자열이라 숫자 변환)
      const fromWttr = async () => {
        const wUrl = `https://wttr.in/${encodeURIComponent(lat)},${encodeURIComponent(lon)}?format=j1`;
        const r = await fetch(wUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!r.ok) throw new Error('wttr ' + r.status);
        const d = await r.json();
        const cc = d.current_condition && d.current_condition[0];
        if (!cc || cc.temp_C == null) throw new Error('wttr empty');
        const ta = parseFloat(cc.temp_C), rh = parseFloat(cc.humidity), ws = parseFloat(cc.windspeedKmph);
        if (isNaN(ta)) throw new Error('wttr parse');
        return { ta: ta, rh: isNaN(rh) ? null : rh, ws: isNaN(ws) ? null : ws, src: 'wttr' };
      };

      // 두 소스를 동시에 호출 → 먼저 성공하는 응답 사용 (Promise.any: 둘 다 실패해야 reject)
      try {
        const w = await Promise.any([fromOpenMeteo(), fromWttr()]);
        return new Response(JSON.stringify(w), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'all weather sources failed' }), { status: 502, headers: cors });
      }
    }

    // (업종별·계산기 통계 엔드포인트는 요청 절약을 위해 제거됨)

    // ── 관리자 인증 (POST /admin-auth) — PIN 검증 후 세션토큰 발급 [v93] ──
    if (url.pathname === '/admin-auth' && request.method === 'POST') {
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };
      if (!env.ADMIN_PIN || !env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ error: 'not_configured' }), { status: 500, headers: cors });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rk = `adminauth:${ip}`;
      let tries = 0;
      try { tries = parseInt((await env.STATS.get(rk)) || '0'); } catch (e) {}
      if (tries >= ADMIN_MAX_TRIES) {
        return new Response(JSON.stringify({ error: 'rate' }), { status: 429, headers: cors });
      }
      let pin = '';
      try { pin = String((await request.json()).pin || ''); } catch (e) {}
      if (!pin || !(await safeEqual(pin, env.ADMIN_PIN))) {
        try { await env.STATS.put(rk, String(tries + 1), { expirationTtl: 3600 }); } catch (e) {}
        return new Response(JSON.stringify({ error: 'unauthorized', left: ADMIN_MAX_TRIES - tries - 1 }), { status: 401, headers: cors });
      }
      try { await env.STATS.delete(rk); } catch (e) {}
      return new Response(JSON.stringify(await adminIssueToken(env)), { headers: cors });
    }

    // ── 관리자 통계 조회 (세션토큰 필요) ──
    if (url.pathname === '/admin-stats') {
      if (!(await adminVerify(request, env))) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin } });
      }
      const today = new Date().toISOString().slice(0, 10);                              // UTC (chat/report/errors — Groq 한도 기준)
      const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST (visits·사람 통계 기준)
      const [
        todayVisits, totalVisits,
        todayChat, totalChat,
        todayReport, totalReport,
        todayErrors, totalErrors
      ] = await Promise.all([
        env.STATS.get(`visits:${todayKst}`),
        env.STATS.get('total:visits'),
        env.STATS.get(`chat:${today}`),
        env.STATS.get('total:chat'),
        env.STATS.get(`report:${today}`),
        env.STATS.get('total:report'),
        env.STATS.get(`errors:${today}`),
        env.STATS.get('total:errors'),
      ]);

      // 날짜별 30일 (병렬 조회 — 순차 루프보다 수십 배 빠름)
      // 행 라벨·visits는 KST(사람 접속/사용자 통계와 정렬), chat/report는 작성된 UTC 키 그대로 조회.
      const weekData = await Promise.all(
        Array.from({ length: 30 }, (_, idx) => {
          const i = 29 - idx;
          const kd = new Date(Date.now() + 9 * 3600 * 1000); kd.setUTCDate(kd.getUTCDate() - i);
          const kstStr = kd.toISOString().slice(0, 10);   // KST 날짜 (라벨·visits)
          const ud = new Date(); ud.setUTCDate(ud.getUTCDate() - i);
          const utcStr = ud.toISOString().slice(0, 10);   // UTC 날짜 (chat/report)
          return Promise.all([
            env.STATS.get(`visits:${kstStr}`),
            env.STATS.get(`chat:${utcStr}`),
            env.STATS.get(`report:${utcStr}`),
          ]).then(([v, c, r]) => ({
            date: kstStr,
            visits: parseInt(v || '0'),
            chat: parseInt(c || '0'),
            report: parseInt(r || '0'),
          }));
        })
      );

      // ── 고유 사용자 집계 (v91: list 제거, 일별 카운터 get 방식) ──
      // 기존 방식(uvisit/uprof를 KV list로 훑어 그 자리에서 합산)은 누적 사용자가 늘면
      // 요청당 외부 호출 한도("Too many API requests by single Worker invocation")에 걸려
      // unique 전체가 실패(사용자 수·누계 미표시)했다.
      // → ping에서 미리 적립해 둔 카운터를 get만으로 읽는다(list 0개 → 한도와 무관·항상 작동):
      //     ucount:<KST날짜>  = 그날 고유 사용자 수 (그날 첫 방문 시 +1)
      //     total:uusers      = 누적 고유 사용자 수 (생애 첫 방문 시 +1)
      //     ureg:total        = 누적 지역 분포 {지역:수}
      //     udev:total        = 누적 기기 분포 {기기:수}
      // (참고) 카운터는 배포 시점부터 적립 → 과거 30일 사용자 추이는 '오늘부터' 채워진다.
      //         오늘 지역/기기 분포·이번달 빈도는 이번 단순화에서 제외(빈 값 → 화면은 '데이터 없음').
      let unique = null;
      try {
        const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

        // KST 기준 최근 30일 날짜 (오래된 → 최신)
        const days = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date(Date.now() + 9 * 3600 * 1000);
          d.setUTCDate(d.getUTCDate() - i);
          days.push(d.toISOString().slice(0, 10));
        }

        // 일별 고유 사용자 카운터 30일치 + 누적 카운터들을 병렬 get (list 없음)
        const [dayCounts, totalUsers, regJson, devJson] = await Promise.all([
          Promise.all(days.map(date => env.STATS.get(`ucount:${date}`).then(v => parseInt(v || '0')))),
          env.STATS.get('total:uusers').then(v => parseInt(v || '0')),
          env.STATS.get('ureg:total', 'json'),
          env.STATS.get('udev:total', 'json'),
        ]);

        const daily = days.map((date, i) => ({ date, users: dayCounts[i] }));
        const last7 = dayCounts.slice(-7).reduce((a, b) => a + b, 0);
        const last30 = dayCounts.reduce((a, b) => a + b, 0);

        unique = {
          users: {
            today: (daily.find(x => x.date === kstToday) || {}).users || 0,
            last7,                                          // 일별 고유의 합(연인원 근사)
            last30,
            total: totalUsers,
          },
          daily,                                          // 30일 고유 사용자 추이(오늘부터 적립)
          today: { byRegion: {}, byDevice: {} },           // (이번 단순화에서 제외)
          visits30: { byRegion: {} },
          cumulative: { byRegion: regJson || {}, byDevice: devJson || {} },   // 누적 지역·기기(주 활용 지표)
          frequency: { heavy: 0, mid: 0, light: 0 },
        };
      } catch (e) {
        unique = { error: e.message };
      }

      const todayVisitsFixed = parseInt(todayVisits || '0');

      return new Response(JSON.stringify({
        unique,
        today: {
          visits: todayVisitsFixed,
          chat: parseInt(todayChat || '0'),
          report: parseInt(todayReport || '0'),
          errors: parseInt(todayErrors || '0'),
        },
        total: {
          visits: parseInt(totalVisits || '0'),
          chat: parseInt(totalChat || '0'),
          report: parseInt(totalReport || '0'),
          errors: parseInt(totalErrors || '0'),
        },
        week: weekData,
        // ③ Groq 실시간 잔여 한도 (마지막 AI 호출 시점 스냅샷)
        groq: await (async () => {
          try {
            const s = await env.STATS.get('groq:ratelimit');
            return s ? JSON.parse(s) : null;
          } catch (e) { return null; }
        })(),
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
        }
      });
    }

    // ── 사용자 의견 접수 (POST /feedback) ──
    if (url.pathname === '/feedback' && request.method === 'POST') {
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };
      let fb;
      try { fb = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: cors });
      }
      // 봇 허니팟: 숨김 필드(hp)가 채워져 있으면 봇 → 성공한 척하고 버림
      if (fb && fb.hp) {
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }
      const cat = ['sug', 'err', 'etc'].includes(fb && fb.cat) ? fb.cat : 'etc';
      const text = ((fb && fb.text) || '').toString().trim().slice(0, 500);
      const contact = ((fb && fb.contact) || '').toString().trim().slice(0, 100);
      const lang = (fb && fb.lang === 'en') ? 'en' : 'ko';
      if (!text) {
        return new Response(JSON.stringify({ error: 'empty' }), { status: 400, headers: cors });
      }
      // 간이 IP 레이트리밋: 시간당 5건
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rk = `fbrate:${ip}`;
        const cnt = parseInt((await env.STATS.get(rk)) || '0');
        if (cnt >= 5) {
          return new Response(JSON.stringify({ error: 'rate' }), { status: 429, headers: cors });
        }
        await env.STATS.put(rk, String(cnt + 1), { expirationTtl: 3600 });
      } catch (e) {}
      // 저장 (180일 자동 만료). 키에 timestamp 포함 → 이름 정렬만으로 최신순 가능
      try {
        const ts = Date.now();
        const key = `fb:${ts}-${Math.random().toString(36).slice(2, 8)}`;
        await env.STATS.put(key, JSON.stringify({ cat, text, contact, lang, ts }), { expirationTtl: 180 * 86400 });
        const tv = await env.STATS.get('total:feedback');
        await env.STATS.put('total:feedback', String(parseInt(tv || '0') + 1));
      } catch (e) {
        return new Response(JSON.stringify({ error: 'store failed' }), { status: 500, headers: cors });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── 관리자: 의견 목록 (GET /admin-feedback) ──
    if (url.pathname === '/admin-feedback') {
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };
      if (!(await adminVerify(request, env))) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });
      }
      try {
        const listed = await env.STATS.list({ prefix: 'fb:' });
        // 키 이름에 timestamp 포함 → 사전순 정렬 후 뒤집으면 최신순. 최대 200건.
        const keys = listed.keys.map(k => k.name).sort().reverse().slice(0, 200);
        const items = [];
        for (const k of keys) {
          const v = await env.STATS.get(k);
          if (v) { try { items.push(JSON.parse(v)); } catch (e) {} }
        }
        return new Response(JSON.stringify({ items, total: items.length }), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ items: [], total: 0, error: e.message }), { headers: cors });
      }
    }

    // ── GET 요청은 무시 ──
    if (request.method !== 'POST') {
      return new Response('OK', {
        headers: { 'Access-Control-Allow-Origin': origin }
      });
    }

    // ── AI 프록시 ──
    const GROQ_API_KEY = env.GROQ_API_KEY;
    const body = await request.json();
    const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
    const systemText = body.system_instruction?.parts?.[0]?.text || '';
    // ✅ 클라이언트가 보내는 type으로 채팅/리포트 명시 분류
    //    (이전: system_instruction 유무로 판단 → 둘 다 system_instruction이 있어 항상 report로 집계되던 버그)
    const isReport = body.type === 'report';

    // ── 법령 근거 모드: 채팅이고 userQuery가 있으면 KB에서 관련 조문 검색 후 근거 주입 ──
    // (구버전 클라이언트는 userQuery를 안 보내므로 자동으로 기존 동작 = 하위호환)
    let lawSources = [];
    let lawGroundMsg = null;
    let lawMatched = [];        // [v94] 답변 검증(lawVerify)에 쓸 실제 주입 근거
    if (!isReport && body.userQuery) {
      try {
        const kb = await getLawKB();
        const matched = lawRetrieve(kb, body.userQuery, LAW_MAX_ARTICLES);
        const top = matched[0]?.score || 0;
        // 직결 사전에 걸렸거나(direct), 법령성 단어가 있거나(forced), 검색 점수가 기준 이상이면 법령 모드
        const direct = matched.some(m => m.direct);
        const forced = LAW_FORCE.some(k => body.userQuery.includes(k)) || /제\s*\d+\s*조/.test(body.userQuery);
        // 직결 사전 적중 → 무조건 주입 / 점수 기준 이상 → 주입 / 법령성 단어가 있으면 기준의 절반까지 허용 (완전 무관한 잡조문은 강제 단어가 있어도 넣지 않음)
        if (matched.length && (direct || top >= LAW_SCORE_MIN || (forced && top >= LAW_SCORE_MIN / 2))) {
          lawGroundMsg = lawGrounding(matched, body.lang === 'en');
          lawSources = matched.map(lawLabel);
          lawMatched = matched;
        }
      } catch (e) { /* KB 로드 실패 시 근거 없이 기존 답변으로 진행 */ }
    }

    const messages = [];
    if (systemText) messages.push({ role: 'system', content: systemText });
    if (lawGroundMsg) messages.push({ role: 'system', content: lawGroundMsg });
    messages.push({ role: 'user', content: prompt });

    try {
      // Groq 호출 본문 (재시도 시 동일하게 재사용)
      const groqPayload = JSON.stringify({
        model: GROQ_MODEL,
        messages,
        // gpt-oss는 추론 토큰이 완성 토큰 예산을 함께 소모한다.
        // 클라이언트 요청값(500~600)만 주면 추론이 예산을 다 먹고 content가 비어
        // 매번 Gemini 폴백으로 새므로, 추론 몫 900을 더해 여유를 준다.
        // (상한선일 뿐이라 실제 토큰 소모가 늘지는 않음)
        max_completion_tokens: (body.generationConfig?.maxOutputTokens || 600) + 900,
        temperature: body.generationConfig?.temperature || 0.7,
        reasoning_effort: 'low',   // 안전 체크리스트 답변엔 low로 충분 (지연·토큰 절감)
        include_reasoning: false,  // 추론 내용이 응답 본문에 섞이지 않게 제외
      });
      // ① User-Agent 추가: Groq API는 Cloudflare 뒤에 있어, UA가 없는 요청을 봇으로 보고
      //    403 Forbidden(code 1010)으로 '간헐' 차단함. 정상 UA를 붙여 차단을 회피한다.
      const callGroq = () => fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'onul-safety/1.0 (+https://yeonskimm.github.io/safety/)',
        },
        body: groqPayload,
      });

      // ② Gemini 폴백 호출부: Groq이 403(IP 차단)·429(한도)·5xx·네트워크 오류로 실패하면
      //    Google Gemini 무료 API로 자동 전환해 답변을 이어간다. (env.GEMINI_API_KEY 필요)
      //    클라이언트가 이미 Gemini 형식(contents/system_instruction/generationConfig)으로 보내므로
      //    거의 그대로 전달하면 되고, 법령 근거(lawGroundMsg)도 system 텍스트에 합쳐 동일 적용한다.
      const callGemini = async (model, disableThinking) => {
        const sys = [systemText, lawGroundMsg].filter(Boolean).join('\n\n');
        const gBody = {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            // thinking을 끈 경우(2.5-flash)는 요청값 그대로 사용.
            // 별칭 재시도처럼 thinking이 켜질 수 있는 모델은 내부 추론이 출력 토큰을
            // 잠식하므로 2048로 여유 있게 상향한다.
            maxOutputTokens: disableThinking ? (body.generationConfig?.maxOutputTokens || 600) : 2048,
            temperature: body.generationConfig?.temperature || 0.7,
          },
        };
        // gemini-2.5-flash는 내부 추론(thinking)이 기본 ON → 끄면 응답이 빠르고 토큰이 절약됨
        if (disableThinking) gBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        if (sys) gBody.systemInstruction = { parts: [{ text: sys }] };
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify(gBody),
        });
        const d = await r.json().catch(() => ({}));
        const t = (d.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
        return { ok: r.ok && !!t, status: r.status, text: t, raw: d };
      };

      // ⓪ [v93] 예측 라우팅: 직전 Groq 응답 헤더 스냅샷(KV groq:ratelimit)으로 한도 소진이 뻔하면
      //    실패→폴백 왕복(2~3초)을 기다리지 않고 Gemini를 먼저 부른다. 리셋 시각이 지났거나 스냅샷이 없으면 평소대로 Groq.
      let text = '', engine = 'groq', geminiTried = false;
      let groqRes = null, groqNetMsg = null, data = null;
      try {
        const snap = JSON.parse((await env.STATS.get('groq:ratelimit')) || 'null');
        if (snap && env.GEMINI_API_KEY) {
          const ageMs = Date.now() - (Date.parse(snap.at) || 0);
          const remTok = parseInt(snap.remainingTokens), remReq = parseInt(snap.remainingRequests);
          const tokLow = !isNaN(remTok) && remTok < GROQ_MIN_TOKENS && ageMs < parseGroqDuration(snap.resetTokens);
          const reqLow = !isNaN(remReq) && remReq < 1 && ageMs < parseGroqDuration(snap.resetRequests);
          if (tokLow || reqLow) {
            geminiTried = true;
            const g = await callGemini(GEMINI_MODEL, true);
            if (g.ok) { text = g.text; engine = 'gemini'; await trackStat(env, 'gemini_preroute'); }
          }
        }
      } catch (e) { /* 스냅샷 해석 실패 시 평소 경로 */ }

      // ③ 1차: Groq 호출. 403은 IP 대역 차단(지속적)이라 재시도가 무의미 → 즉시 Gemini 폴백으로.
      //    5xx·네트워크 throw만 일시 장애일 수 있어 0.6초 쉬고 1회 재시도한다.
      if (!text) try {
        groqRes = await callGroq();
        if (groqRes.status >= 500) {
          console.log('GROQ_RETRY', 'firstStatus=' + groqRes.status);
          await new Promise(r => setTimeout(r, 600));
          groqRes = await callGroq();
        }
      } catch (netErr) {
        groqNetMsg = netErr && netErr.message;
        console.log('GROQ_RETRY_NET', 'err=' + groqNetMsg);
        try {
          await new Promise(r => setTimeout(r, 600));
          groqRes = await callGroq();
        } catch (netErr2) { groqRes = null; groqNetMsg = netErr2 && netErr2.message; }
      }

      // 1010 봇차단처럼 본문이 HTML(JSON 아님)이어도 여기서 죽지 않도록 안전 파싱
      if (groqRes) data = await groqRes.json().catch(() => null);

      // ④ Groq 실시간 잔여 한도 스냅샷 저장 (성공/429 모두 헤더 존재)
      try {
        if (groqRes) {
          const snap = {
            limitRequests: groqRes.headers.get('x-ratelimit-limit-requests'),
            remainingRequests: groqRes.headers.get('x-ratelimit-remaining-requests'),
            limitTokens: groqRes.headers.get('x-ratelimit-limit-tokens'),
            remainingTokens: groqRes.headers.get('x-ratelimit-remaining-tokens'),
            resetRequests: groqRes.headers.get('x-ratelimit-reset-requests'),
            resetTokens: groqRes.headers.get('x-ratelimit-reset-tokens'),
            at: new Date().toISOString(),
          };
          if (snap.remainingRequests != null || snap.remainingTokens != null) {
            await env.STATS.put('groq:ratelimit', JSON.stringify(snap), { expirationTtl: 2 * 86400 });
          }
        }
      } catch (e) {}

      if (!text && groqRes && groqRes.ok && data) text = data.choices?.[0]?.message?.content || '';

      // ⑤ Groq 실패(403 차단·429 한도·5xx·네트워크·빈 응답) → Gemini 폴백 시도 (예측 라우팅에서 이미 실패했으면 생략)
      if (!text && !geminiTried) {
        const gs = groqRes ? groqRes.status : 'net';
        console.log('GROQ_FAIL', 'status=' + gs, 'body=' + JSON.stringify(data).slice(0, 300), 'netErr=' + groqNetMsg, 'retryAfter=' + (groqRes && groqRes.headers.get('retry-after')), 'rlReq=' + (groqRes && groqRes.headers.get('x-ratelimit-remaining-requests')), 'rlTok=' + (groqRes && groqRes.headers.get('x-ratelimit-remaining-tokens')));
        if (env.GEMINI_API_KEY) {
          try {
            let g = await callGemini(GEMINI_MODEL, true);
            // 모델 폐지(404)·파라미터 불일치(400) 시 최신 별칭으로 1회 재시도 (향후 모델 교체기 대비)
            if (!g.ok && (g.status === 404 || g.status === 400)) g = await callGemini('gemini-flash-latest', false);
            if (g.ok) {
              text = g.text; engine = 'gemini';
              await trackStat(env, 'gemini_fallback');
              console.log('GEMINI_FALLBACK_OK', 'groqStatus=' + gs);
            } else {
              console.log('GEMINI_FALLBACK_FAIL', 'status=' + g.status, 'body=' + JSON.stringify(g.raw).slice(0, 300));
            }
          } catch (gemErr) {
            console.log('GEMINI_FALLBACK_FAIL', 'err=' + (gemErr && gemErr.message));
          }
        } else {
          console.log('GEMINI_FALLBACK_SKIP', 'no GEMINI_API_KEY');
        }
      }

      // Groq이 200인데 본문만 비어 있고 Gemini도 못 채운 극히 드문 경우: 기존 안내 문구 유지
      if (!text && groqRes && groqRes.ok) text = '응답을 받지 못했습니다.';

      // ⑥ 둘 다 실패 → 기존과 동일한 형식으로 에러 반환 (앱의 E403/한도 안내 표시 로직 그대로 동작)
      if (!text) {
        await trackStat(env, 'errors');
        return new Response(JSON.stringify({ error: data || { error: { message: groqNetMsg || 'AI unavailable' } } }), {
          status: groqRes ? groqRes.status : 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
        });
      }

      await trackStat(env, isReport ? 'report' : 'chat');

      // ⑦ [v94] 답변 검증: 주입한 근거에 없는 조문번호가 답변에 있으면 표기를 떼고 확인 안내를 붙인다.
      //    근거가 주입된 경우에만 동작하므로 일반 안전상담 답변은 그대로 지나간다.
      let lawStripped = [];
      if (lawMatched.length) {
        const v = lawVerify(text, lawMatched, body.lang === 'en');
        text = v.text; lawStripped = v.stripped;
        if (lawStripped.length) {
          console.log('LAW_HALLUCINATION', 'engine=' + engine, 'stripped=' + JSON.stringify(lawStripped).slice(0, 200), 'q=' + String(body.userQuery || '').slice(0, 80));
          await trackStat(env, 'law_stripped');
        }
      }

      // engine: 어떤 백엔드가 답했는지(groq/gemini). 현 클라이언트는 이 필드를 무시하므로 무해.
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        lawSources,
        lawStripped,
        engine
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
        }
      });

    } catch (e) {
      await trackStat(env, 'errors');
      return new Response(JSON.stringify({ error: { message: e.message } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
      });
    }
  }
};

async function trackStat(env, type) {
  try {
    // visits(사람 접속)는 KST 날짜로 집계 → 한국 하루와 일치.
    // chat/report/errors는 Groq 무료 한도(UTC 자정 리셋)에 맞춰 UTC 날짜 유지.
    const offsetMs = (type === 'visits') ? 9 * 3600 * 1000 : 0;
    const today = new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
    const dayKey = `${type}:${today}`;
    const totalKey = `total:${type}`;
    const [dayVal, totalVal] = await Promise.all([
      env.STATS.get(dayKey),
      env.STATS.get(totalKey),
    ]);
    await Promise.all([
      env.STATS.put(dayKey, String(parseInt(dayVal || '0') + 1), { expirationTtl: 90 * 86400 }),
      env.STATS.put(totalKey, String(parseInt(totalVal || '0') + 1)),
    ]);
  } catch (e) {
    // 통계 실패해도 앱 동작에 영향 없음
  }
}
