// 관리자 인증·duration 파서 단위 테스트 (worker.js의 해당 구간을 그대로 실행)
const fs=require('fs'), path=require('path');
const ROOT=process.env.APP_DIR||path.join(__dirname,'..'); const src=fs.readFileSync(path.join(ROOT,'worker.js'),'utf8');
const a=src.indexOf('const ADMIN_SESSION_SEC'), b=src.indexOf('export default');
const region=src.slice(a,b);
const run=new Function('crypto','TextEncoder','TextDecoder','btoa','atob',region+`
return (async()=>{
  const env={ADMIN_SECRET:'test-secret-0123456789abcdef', ADMIN_PIN:'123456'};
  const req=(tok)=>({headers:{get:(k)=>k==='Authorization'?('Bearer '+tok):null}});
  const {token,exp}=await adminIssueToken(env);
  const ok1=await adminVerify(req(token),env);
  const tampered=token.slice(0,-3)+'AAA';
  const ok2=await adminVerify(req(tampered),env);
  const ok3=await adminVerify(req(token),{ADMIN_SECRET:'other'});
  // 만료 토큰: exp 과거로 직접 서명
  const past=_enc.encode(JSON.stringify({exp:Math.floor(Date.now()/1000)-10,n:'x'}));
  const sig=await crypto.subtle.sign('HMAC',await _hmacKey(env.ADMIN_SECRET),past);
  const ok4=await adminVerify(req(_b64u(past)+'.'+_b64u(sig)),env);
  const ok5=await adminVerify({headers:{get:()=>null}},env);
  const eq1=await safeEqual('123456','123456'), eq2=await safeEqual('123456','123457'), eq3=await safeEqual('','123456');
  const d=[parseGroqDuration('2m59.56s'),parseGroqDuration('7.66s'),parseGroqDuration('900ms'),parseGroqDuration('1h2m'),parseGroqDuration(null),parseGroqDuration('abc')];
  return {ok1,ok2,ok3,ok4,ok5,eq1,eq2,eq3,d,expIn:exp-Math.floor(Date.now()/1000),tokenLen:token.length};
})();`);
run(globalThis.crypto,TextEncoder,TextDecoder,btoa,atob).then(r=>{
  const pass = r.ok1===true && r.ok2===false && r.ok3===false && r.ok4===false && r.ok5===false && r.eq1===true && r.eq2===false && r.eq3===false
    && r.d[0]===179560 && r.d[1]===7660 && r.d[2]===900 && r.d[3]===3720000 && r.d[4]===0 && r.d[5]===0 && r.expIn===1800;
  console.log(JSON.stringify(r)); console.log(pass?'ADMIN_AUTH_TESTS PASS':'ADMIN_AUTH_TESTS FAIL'); process.exitCode=pass?0:1;
});
