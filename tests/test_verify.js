// 답변 검증(lawVerify) 단위 테스트
const fs=require('fs'), path=require('path');
const ROOT=process.env.APP_DIR||path.join(__dirname,'..');const src=fs.readFileSync(process.argv[2]||path.join(ROOT,'worker.js'),'utf8');
const region=src.slice(src.indexOf('// ── LAW_RETRIEVAL_BEGIN'),src.indexOf('// ── LAW_RETRIEVAL_END'));
const kb=JSON.parse(fs.readFileSync(path.join(ROOT,'law_kb.json'),'utf8'));
const F=new Function('kb',region+`return {lawRetrieve,lawVerify,lawGrounding};`)(kb);
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
console.log(`\nVERIFY 테스트 ${pass}/${pass+fail} 통과`); process.exitCode=fail?1:0;
