# test_privacy.py — v96 개인정보 안내(의견 보내기 동의·접힘 안내, AI 채팅 안내문) 렌더링·동작 테스트
# 사용: python3 tests/test_privacy.py   (Worker 응답은 모킹)
import json, os, time, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
PORT = 8766
ROOT = os.environ.get('APP_DIR') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY = 'https://safety-ai-proxy.darksky166.workers.dev'
SHOT = os.environ.get('SHOT_DIR')
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
    def translate_path(self,p): return os.path.join(ROOT, p.lstrip('/').split('?')[0] or 'index.html')
def serve():
    socketserver.TCPServer.allow_reuse_address=True
    with socketserver.TCPServer(('127.0.0.1',PORT),Q) as h: h.serve_forever()
threading.Thread(target=serve,daemon=True).start(); time.sleep(0.4)
sent=[]
mode={'ai':'ok'}
def handle(route, req):
    H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}
    if req.method=='OPTIONS': return route.fulfill(status=204,headers={**H,'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, GET, OPTIONS'})
    path=req.url[len(PROXY):].split('?')[0]
    if path=='/feedback': sent.append(json.loads(req.post_data or '{}')); return route.fulfill(status=200,headers=H,body='{"ok":true}')
    if mode['ai']=='ip' and req.method=='POST' and path in ('','/'):
        return route.fulfill(status=429,headers=H,body=json.dumps({'error':{'message':'RATE_LIMIT ip'},'limit':{'kind':'ip','retryMs':42000}}))
    return route.fulfill(status=200,headers=H,body='{"ok":true}')
res=[]
def check(n,c): res.append(bool(c)); print(('✅ ' if c else '❌ ')+n)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
    page=ctx.new_page(); errs=[]; page.on('pageerror',lambda e: errs.append(str(e)))
    page.route(PROXY+'/**',handle); page.route(PROXY,handle)
    page.route('**/googletagmanager.com/**',lambda r,q: r.fulfill(status=200,body=''))
    page.goto(f'http://127.0.0.1:{PORT}/index.html',wait_until='load'); page.wait_for_timeout(1200)
    for lang in ('ko','en'):
        page.evaluate(f"state.lang='{lang}'; render();"); page.wait_for_timeout(200)
        sent.clear(); page.evaluate("closeFeedback(); openFeedback()"); page.wait_for_timeout(200)
        vis=lambda sel: page.evaluate(f"(()=>{{const e=document.querySelector('{sel}');return !!e&&getComputedStyle(e).display!=='none'}})()")
        check(f'[{lang}] 처음엔 동의 블록 숨김', not vis('#fb-consent'))
        check(f'[{lang}] 처리 안내는 접힌 상태', not vis('#fb-privacy'))
        page.fill('#fb-text','체감온도 글씨가 작아요')
        page.click('#fb-send'); page.wait_for_timeout(300)
        check(f'[{lang}] 연락처 없이 전송 → 동의 없이 전송됨', len(sent)==1 and sent[0].get('contact')=='')
        sent.clear(); page.evaluate("closeFeedback(); openFeedback()"); page.wait_for_timeout(150)
        page.fill('#fb-text','의견'); page.fill('#fb-contact','010-0000-0000')
        check(f'[{lang}] 연락처 입력 → 동의 블록 표시', vis('#fb-consent'))
        if SHOT and lang=='ko': page.screenshot(path=f'{SHOT}/demo_fb_consent.png')
        page.click('#fb-send'); page.wait_for_timeout(300)
        msg=page.inner_text('#fb-err')
        check(f'[{lang}] 미동의 전송 차단 + 안내', len(sent)==0 and vis('#fb-err') and len(msg)>5)
        page.check('#fb-agree'); page.fill('#fb-contact',''); page.dispatch_event('#fb-contact','input')
        check(f'[{lang}] 연락처 지우면 블록 숨김·체크 해제', (not vis('#fb-consent')) and not page.is_checked('#fb-agree'))
        page.fill('#fb-contact','a@b.kr'); page.check('#fb-agree'); page.click('#fb-send'); page.wait_for_timeout(300)
        check(f'[{lang}] 동의 후 전송 성공(연락처 포함)', len(sent)==1 and sent[0].get('contact')=='a@b.kr' and vis('#fb-done'))
        page.evaluate("closeFeedback(); openFeedback()"); page.wait_for_timeout(150)
        page.click('#fb-more'); page.wait_for_timeout(150)
        txt=page.inner_text('#fb-privacy')
        check(f'[{lang}] 접힘 링크 펼침 + GA·180일·외부 AI 포함', vis('#fb-privacy') and 'Google Analytics' in txt and '180' in txt and page.get_attribute('#fb-more','aria-expanded')=='true')
        if SHOT and lang=='ko': page.screenshot(path=f'{SHOT}/demo_fb_privacy.png')
        page.click('#fb-more'); page.wait_for_timeout(100)
        check(f'[{lang}] 다시 누르면 접힘', not vis('#fb-privacy'))
        page.evaluate("closeFeedback()")
        page.evaluate("state.industry=(INDUSTRIES[0]||{}).id; state.step=5; render();"); page.wait_for_timeout(300)
        note=page.evaluate("(document.querySelector('.ai-chat-pinote')||{}).innerText||''")
        check(f'[{lang}] AI 채팅 안내문 표시', ('외부 AI' in note) if lang=='ko' else ('external AI' in note))
        h=page.evaluate("(()=>{const e=document.querySelector('.ai-chat-pinote');return e?e.getBoundingClientRect().height:0})()")
        check(f'[{lang}] 안내문 한 줄(높이 {h:.0f}px)', 0<h<=18)
        if SHOT: page.screenshot(path=f'{SHOT}/demo_chat_{lang}.png')
        mode['ai']='ip'; page.fill('#ai-chat-ta','테스트'); page.evaluate('sendAiChat()'); page.wait_for_timeout(600); mode['ai']='ok'
        last=page.evaluate("(()=>{const m=[...document.querySelectorAll('.ai-msg.ai')];return m.length?m[m.length-1].innerText:''})()")
        check(f'[{lang}] 서버 IP 한도(429 ip) → 대기 안내 E429-I·42초', 'E429-I' in last and '42' in last)
        page.evaluate("state.step=0; render();")
    check('JS 예외 없음'+(' '+str(errs[:2]) if errs else ''), not errs)
    b.close()
print(f'\nPRIVACY 테스트 {sum(res)}/{len(res)} 통과'); raise SystemExit(0 if all(res) else 1)
