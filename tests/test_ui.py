# test_ui.py — v93 관리자 인증 흐름 렌더링 테스트 (Playwright, iPhone 뷰포트, Worker 응답은 모킹)
# 사용: python3 test_ui.py   (같은 폴더의 index.html을 로컬 http로 띄워 검사)
import json, re, time, threading, http.server, socketserver, os, sys
from playwright.sync_api import sync_playwright

PORT = 8765
ROOT = os.environ.get('APP_DIR') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 기본: 저장소 루트(index.html 위치)
PROXY = 'https://safety-ai-proxy.darksky166.workers.dev'
# 아래 값은 이 테스트 안에서만 쓰는 가짜 PIN이다. Worker 응답을 모킹하므로 실제 서버와 무관하며,
# 실제 관리자 PIN은 Cloudflare Worker의 Secret(ADMIN_PIN)에만 존재하고 이 저장소 어디에도 없다.
GOOD_PIN = '135790'          # 테스트 전용 더미 값
TOKEN = 'dGVzdA.c2ln'

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def translate_path(self, path):
        return os.path.join(ROOT, path.lstrip('/').split('?')[0] or 'index.html')

def serve():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), Quiet) as httpd:
        httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start(); time.sleep(0.5)

state = {'stats_mode': 'ok', 'auth_mode': 'normal', 'auth_calls': []}
STATS = {
    'unique': {'users': {'today': 7, 'last30': 120, 'total': 412}, 'daily': [{'date': '2026-09-19', 'users': 7}],
               'cumulative': {'byRegion': {'대구': 300, '경북': 112}, 'byDevice': {'iOS': 250, 'Android': 162}}},
    'today': {'visits': 31, 'chat': 9, 'report': 4, 'errors': 0},
    'total': {'visits': 5120, 'chat': 880, 'report': 402, 'errors': 12},
    'week': [], 'groq': {'remainingTokens': '6100', 'limitTokens': '8000', 'remainingRequests': '28', 'limitRequests': '30'},
}

def handle(route, request):
    url = request.url; path = url[len(PROXY):].split('?')[0]
    auth = request.headers.get('authorization', '')
    if request.method == 'OPTIONS':
        return route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'})
    H = {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}
    if path == '/admin-auth':
        body = json.loads(request.post_data or '{}'); state['auth_calls'].append(body.get('pin'))
        if state['auth_mode'] == 'rate': return route.fulfill(status=429, headers=H, body=json.dumps({'error': 'rate'}))
        if state['auth_mode'] == 'noconf': return route.fulfill(status=500, headers=H, body=json.dumps({'error': 'not_configured'}))
        if body.get('pin') == GOOD_PIN: return route.fulfill(status=200, headers=H, body=json.dumps({'token': TOKEN, 'exp': int(time.time()) + 1800}))
        return route.fulfill(status=401, headers=H, body=json.dumps({'error': 'unauthorized', 'left': 4}))
    if path in ('/admin-stats', '/admin-feedback'):
        if auth != 'Bearer ' + TOKEN or state['stats_mode'] == 'expired':
            return route.fulfill(status=401, headers=H, body=json.dumps({'error': 'unauthorized'}))
        return route.fulfill(status=200, headers=H, body=json.dumps(STATS if path == '/admin-stats' else {'items': [], 'total': 0}))
    if path == '/ping': return route.fulfill(status=200, headers=H, body=json.dumps({'ok': True, 'today': 31}))
    if path == '/weather': return route.fulfill(status=200, headers=H, body=json.dumps({'error': 'mock'}))
    return route.fulfill(status=200, headers=H, body=json.dumps({'candidates': [{'content': {'parts': [{'text': 'mock'}]}}]}))

results = []
def check(name, cond):
    results.append((name, bool(cond))); print(('✅ ' if cond else '❌ ') + name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    NOISE = ('Failed to load resource', 'CORS policy', 'net::', 'favicon')   # 샌드박스 네트워크 차단·모킹 401 등 리소스 로드 실패는 JS 예외가 아님
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' and not any(n in m.text for n in NOISE) else None)
    page.route(PROXY + '/**', handle); page.route(PROXY, handle)
    page.route('**/api.open-meteo.com/**', lambda r, q: r.fulfill(status=200, body='{}', headers={'Content-Type': 'application/json'}))
    page.route('**/api.bigdatacloud.net/**', lambda r, q: r.fulfill(status=200, body='{}', headers={'Content-Type': 'application/json'}))
    page.goto(f'http://127.0.0.1:{PORT}/index.html', wait_until='load'); page.wait_for_timeout(1500)
    page.screenshot(path='shot_1_home.png')
    check('홈 렌더링 (JS 예외 없음)', not errors)
    check('APP_VERSION v94', page.evaluate('typeof APP_VERSION!=="undefined" && APP_VERSION') == 'v94')
    check('AI_PROXY_URL 정의 / GEMINI_URL 제거', page.evaluate('typeof AI_PROXY_URL==="string" && typeof GEMINI_URL==="undefined"'))
    check('구 PIN 문자열이 페이지 소스에 없음', '987502' not in page.content() and 'safety-admin-2024' not in page.content())

    # 1) 5탭 → PIN 화면
    page.evaluate('for(let i=0;i<5;i++)_adminTap()'); page.wait_for_timeout(300)
    check('5탭 → PIN 화면 표시', page.locator('#admin-overlay').count() == 1 and page.locator('#admin-dash').count() == 0)
    page.screenshot(path='shot_2_pin.png')

    # 2) 틀린 PIN → 서버 401 → 흔들림 + 안내
    for k in '000000': page.click(f'#admin-overlay button:has-text("{k}")')
    page.wait_for_timeout(400)
    hint = page.locator('#admin-pin-hint').inner_text()
    check('틀린 PIN → 서버 검증 401 → "남은 시도" 안내', '틀렸' in hint and '4회' in hint)
    page.screenshot(path='shot_3_pin_wrong.png')
    page.wait_for_timeout(700)

    # 3) 맞는 PIN → 토큰 저장 → 대시보드
    for k in GOOD_PIN: page.click(f'#admin-overlay button:has-text("{k}")')
    page.wait_for_timeout(900)
    check('맞는 PIN → 대시보드 표시', page.locator('#admin-dash').count() == 1 and page.locator('#admin-overlay').count() == 0)
    check('세션토큰이 sessionStorage에만 저장', page.evaluate('sessionStorage.getItem("adm_tok")') == TOKEN and page.evaluate('localStorage.getItem("adm_tok")') is None)
    dash_txt = page.locator('#admin-dash').inner_text()
    check('대시보드에 통계 수치 반영 (오늘 방문 31 / 채팅 9 / 리포트 4)', all(x in dash_txt for x in ('31', '9', '4')))
    print('   대시보드 텍스트 발췌:', re.sub(r'\s+', ' ', dash_txt)[:260])
    check('서버로 전송된 PIN 순서 = [틀린, 맞는]', state['auth_calls'] == ['000000', GOOD_PIN])
    page.screenshot(path='shot_4_dash.png')

    # 4) 닫고 다시 5탭 → 세션 유효 → PIN 생략
    page.evaluate('_adminClose()'); page.wait_for_timeout(200)
    page.evaluate('for(let i=0;i<5;i++)_adminTap()'); page.wait_for_timeout(600)
    check('세션 유효 시 5탭 → PIN 생략, 바로 대시보드', page.locator('#admin-dash').count() == 1 and page.locator('#admin-overlay').count() == 0)
    check('추가 인증 호출 없음', len(state['auth_calls']) == 2)

    # 5) 세션 만료(서버 401) → PIN 화면 + 안내
    page.evaluate('_adminClose()'); state['stats_mode'] = 'expired'
    page.evaluate('for(let i=0;i<5;i++)_adminTap()'); page.wait_for_timeout(800)
    hint = page.locator('#admin-pin-hint').inner_text() if page.locator('#admin-pin-hint').count() else ''
    check('세션 만료 → 대시보드 닫고 PIN 화면 + 만료 안내', page.locator('#admin-overlay').count() == 1 and '만료' in hint)
    check('만료 시 토큰 폐기', page.evaluate('sessionStorage.getItem("adm_tok")') is None)
    page.screenshot(path='shot_5_expired.png')

    # 6) 시도 초과(429) / 미설정(500) 안내
    state['auth_mode'] = 'rate'
    for k in '111111': page.click(f'#admin-overlay button:has-text("{k}")')
    page.wait_for_timeout(400); hint = page.locator('#admin-pin-hint').inner_text()
    check('시도 초과(429) 안내', '초과' in hint)
    page.wait_for_timeout(700); state['auth_mode'] = 'noconf'
    for k in '111111': page.click(f'#admin-overlay button:has-text("{k}")')
    page.wait_for_timeout(400); hint = page.locator('#admin-pin-hint').inner_text()
    check('Secret 미설정(500) 안내', 'Secret' in hint)
    page.evaluate('_adminClose()')

    # 7) AI 채팅 화면 진입 (명칭 변경 후 화면 회귀 확인)
    opened = page.evaluate('''() => { const f = window.openAiChat || window.aiOpenChat || window.showAiChat; if (typeof f === "function") { f(); return true; } return false; }''')
    page.wait_for_timeout(500); page.screenshot(path='shot_6_after.png')
    check('전체 흐름 동안 JS 예외 없음', not errors)
    if errors: print('  예외 목록:', errors[:5])
    browser.close()

ok = all(r for _, r in results)
print(f'\nUI 테스트 {sum(r for _, r in results)}/{len(results)} 통과')
sys.exit(0 if ok else 1)
