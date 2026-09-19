// 답변 검증(lawVerify) 단위 테스트
const fs=require('fs'), path=require('path');
const ROOT=process.env.APP_DIR||path.join(__dirname,'..');const src=fs.readFileSync(process.argv[2]||path.join(ROOT,'worker.js'),'utf8');
const region=src.slice(src.indexOf('// ── LAW_RETRIEVAL_BEGIN'),src.indexOf('// ── LAW_RETRIEVAL_END'));
const kb=JSON.parse(fs.readFileSync(path.join(ROOT,'law_kb.json'),'utf8'));
const F=new Function('kb',region+`return {lawRetrieve,lawVerify,lawGrounding,lawProvisos};`)(kb);
const m=F.lawRetrieve(kb,'산업재해조사표는 언제제출해야해?');
let pass=0,fail=0;
const t=(name,cond)=>{cond?pass++:fail++;console.log((cond?'✅ ':'❌ ')+name);};
// 1) 주입된 조문(제73조) 인용은 그대로
let r=F.lawVerify('산업재해조사표는 1개월 이내 제출합니다. 📖 근거: 시행규칙 제73조',m,false);
t('주입된 제73조 인용 → 유지', r.text.includes('제73조') && r.stripped.length===0 && !r.text.includes('⚠️'));
// 2) 원문이 가리키는 조문(법 제57조)도 허용
r=F.lawVerify('법 제57조제3항에 따라 보고합니다.',m,false);
t('원문에 적힌 법 제57조 → 유지', r.text.includes('제57조') && r.stripped.length===0);
// 3) 지어낸 조문번호는 중화 + 경고
r=F.lawVerify('시행규칙 제999조에 따라 7일 이내 제출합니다.',m,false);
t('미주입 제999조 → 표기 제거 + 경고', !r.text.includes('제999조') && r.text.includes('관련 규정') && r.text.includes('⚠️') && r.stripped[0]==='제999조');
// 4) 근거가 없으면(법령 모드 미발동) 건드리지 않음
r=F.lawVerify('제999조라고 답함',[],false);
t('근거 미주입 시 원문 그대로', r.text==='제999조라고 답함' && r.stripped.length===0);
// 5) 영문 모드
r=F.lawVerify('Under Article 제999조 you must report.',m,true);
t('영문 모드 안내문', r.text.includes('(the relevant provision)') && r.text.includes('law.go.kr'));
// 6) 별표 인용 허용
const m2=F.lawRetrieve(kb,'안전보건교육 안하면 과태료 얼마야');
r=F.lawVerify('근로자 1명당 10만원입니다. 📖 근거: 시행령 별표 35',m2,false);
t('별표 근거 인용 → 경고 없음', !r.text.includes('⚠️'));
// 7) 예산 상한
const g=F.lawGrounding(m2,false);
t('주입 근거 길이 예산 내', g.length < 4200);
// ── [v94.1] 적용 요건·단서 추출 ──
const p73=F.lawProvisos(F.lawRetrieve(kb,'산업재해조사표는 언제제출해야해?')).join('\n');
t('제73조② 단서: "각 호의 모두에 해당하지 않는 사업주" 포함', p73.includes('각 호의 모두에 해당하지 않는 사업주'));
t('제73조② 단서: "처음 발생한 산업재해" 포함', p73.includes('처음 발생한'));
t('제73조② 제외 대상 4가지 전부 포함', ['안전관리자 또는 보건관리자','안전보건총괄책임자','건설재해예방전문지도기관','은폐하려고 한 사업주'].every(k=>p73.includes(k)));
t('제73조③ 단서: 근로자대표 없을 때 재해자 확인', p73.includes('근로자대표가 없는 경우'));
t('제339조 단서(건설기술 진흥법 설계도서 예외) 추출', F.lawProvisos(F.lawRetrieve(kb,'굴착면 기울기 기준')).join(' ').includes('건설기술 진흥법'));
t('개정 이력 날짜가 각 호 항목으로 오인되지 않음', !/각 호: 1\. \d/.test(F.lawProvisos(F.lawRetrieve(kb,'지게차 작업 전 점검사항')).join(' ')));
t('단서 안내 총량 상한(760자) 준수', ['휴게시설 설치 의무 사업장은?','안전보건교육 안하면 과태료 얼마야','화학물질 경고표시 어떻게 해야해'].every(q=>F.lawProvisos(F.lawRetrieve(kb,q)).join('').length<=760+160));
const g73=F.lawGrounding(F.lawRetrieve(kb,'산업재해조사표는 언제제출해야해?'),false);
t('프롬프트에 단서 안내 블록 삽입', g73.includes('[위 원문에 있는 적용 요건·단서') && g73.includes('은폐하려고 한 사업주'));
t('단서 안내 포함해도 주입 길이 4,000자 이내', g73.length < 4000);
console.log(`\nVERIFY 테스트 ${pass}/${pass+fail} 통과`); process.exitCode=fail?1:0;
