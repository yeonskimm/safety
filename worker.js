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
const LAW_KB_URL = 'https://yeonskimm.github.io/safety/law_kb.json';
const LAW_SCORE_MIN = 6;                       // 검색 점수 ≥ 이 값이면 '법령 모드'
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
let LAW_KB = null, LAW_KB_AT = 0;
async function getLawKB() {
  if (LAW_KB && (Date.now() - LAW_KB_AT) < 3600000) return LAW_KB;
  const res = await fetch(LAW_KB_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error('KB status ' + res.status);
  LAW_KB = await res.json(); LAW_KB_AT = Date.now();
  return LAW_KB;
}
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
function lawLabel(r) { return `${r.lawName} 제${r.jo}조${r.ui ? '의' + r.ui : ''}(${r.title})`; }
function lawGrounding(matched, isEn) {
  const body = matched.map(r => `【${lawLabel(r)}】\n${r.text.slice(0, 900)}`).join('\n\n');
  if (isEn) return '[Legal text — you MAY cite ONLY the articles below. Never fabricate article numbers or content. If the answer is not in this text, say you are not certain.]\n\n' + body + '\n\nEnd your answer with "📖 Source: ..." citing only the articles you used. Answer in English only.';
  return '[법령 원문 — 아래 조문에 한해 정확히 인용해도 됩니다. 이 원문에 없는 조문번호·내용은 절대 지어내지 마세요. 원문에서 답을 못 찾으면 솔직히 모른다고 하세요.]\n\n' + body + '\n\n답변 맨 끝에 사용한 조문을 "📖 근거: ○○ 제○조(제목)" 형식으로 표기하세요. 한자·일본어 없이 순수 한글로만 답하세요.';
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
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
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
 
    // ── 관리자 통계 조회 ──
    if (url.pathname === '/admin-stats') {
      const token = request.headers.get('X-Admin-Token');
      if (token !== 'safety-admin-2024') {
        return new Response('Unauthorized', { status: 401 });
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
      const token = request.headers.get('X-Admin-Token');
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };
      if (token !== 'safety-admin-2024') {
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
    if (!isReport && body.userQuery) {
      try {
        const kb = await getLawKB();
        const matched = lawRetrieve(kb, body.userQuery, 3);
        const top = matched[0]?.score || 0;
        const forced = LAW_FORCE.some(k => body.userQuery.includes(k)) || /제\s*\d+\s*조/.test(body.userQuery);
        if (matched.length && (forced || top >= LAW_SCORE_MIN)) {
          lawGroundMsg = lawGrounding(matched, body.lang === 'en');
          lawSources = matched.map(lawLabel);
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
 
      // ③ 1차: Groq 호출. 403은 IP 대역 차단(지속적)이라 재시도가 무의미 → 즉시 Gemini 폴백으로.
      //    5xx·네트워크 throw만 일시 장애일 수 있어 0.6초 쉬고 1회 재시도한다.
      let groqRes = null, groqNetMsg = null;
      try {
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
      const data = groqRes ? await groqRes.json().catch(() => null) : null;
 
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
 
      let text = (groqRes && groqRes.ok && data) ? (data.choices?.[0]?.message?.content || '') : '';
      let engine = 'groq';
 
      // ⑤ Groq 실패(403 차단·429 한도·5xx·네트워크·빈 응답) → Gemini 폴백 시도
      if (!text) {
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
 
      // engine: 어떤 백엔드가 답했는지(groq/gemini). 현 클라이언트는 이 필드를 무시하므로 무해.
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        lawSources,
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
 