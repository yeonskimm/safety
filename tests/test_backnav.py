# test_backnav.py — v98 안드로이드 시스템 뒤로가기 테스트 (Playwright, 안드로이드 뷰포트)
# 시스템 뒤로가기 = 브라우저 history back 과 같으므로 page.go_back()으로 재현한다.
# 사용: python3 tests/test_backnav.py
import os, sys, time, threading, http.server, socketserver
from playwright.sync_api import sync_playwright

PORT = 8767
ROOT = os.environ.get('APP_DIR') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.environ.get('APP_PAGE', 'index.html')

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def translate_path(self, path):
        return os.path.join(ROOT, path.lstrip('/').split('?')[0] or 'index.html')

def serve():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), Quiet) as httpd:
        httpd.serve_forever()
threading.Thread(target=serve, daemon=True).start(); time.sleep(0.5)

results = []
def check(name, ok):
    results.append((name, bool(ok))); print(('  ✅ ' if ok else '  ❌ ') + name)

JSON = {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}
with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('**/*.workers.dev/**', lambda r, q: r.fulfill(status=200, body='{}', headers=JSON))
    page.route('**/api.open-meteo.com/**', lambda r, q: r.fulfill(status=200, body='{}', headers=JSON))
    page.route('**/api.bigdatacloud.net/**', lambda r, q: r.fulfill(status=200, body='{}', headers=JSON))
    page.route('**/www.googletagmanager.com/**', lambda r, q: r.fulfill(status=200, body='', headers={'Content-Type': 'text/javascript'}))
    dialogs = []
    answer = {'v': False}
    def on_dialog(d):
        dialogs.append(d.message); (d.accept() if answer['v'] else d.dismiss())
    page.on('dialog', on_dialog)

    page.goto(f'http://127.0.0.1:{PORT}/{PAGE}', wait_until='load'); page.wait_for_timeout(1200)
    step = lambda: page.evaluate('state.step')
    back = lambda: (page.go_back(), page.wait_for_timeout(250))
    hist_len = lambda: page.evaluate('history.length')
    toast_on = lambda: page.evaluate("!!document.querySelector('#os-back-toast.show')")

    check('초기: 터치 전에는 가드를 넣지 않음(크롬 건너뜀 방지)', page.evaluate('_osBack.guards()') == 0 and page.evaluate('history.state&&history.state.osG') == 0)
    check('안드로이드 판정(IS_IOS=false)', page.evaluate('_osBack.isIOS') is False)

    # 1) 홈 → 업종 → 작업 → 체크리스트
    page.click('button.home-btn[onclick="go(1)"]'); page.wait_for_timeout(200)
    check('시작하기 → 1단계, 가드 5칸 채움', step() == 1 and page.evaluate('_osBack.guards()') == 5 and page.evaluate('history.state.osG') == 5)
    L = hist_len()
    page.locator('button.i-btn').first.click(); page.wait_for_timeout(200)
    page.locator('button.det-btn').first.click(); page.wait_for_timeout(150)
    page.click('button.big-btn[onclick="startCheck()"]'); page.wait_for_timeout(200)
    check('체크리스트(3단계) 진입', step() == 3)
    check('화면을 옮겨도 방문기록이 늘지 않음', hist_len() == L)

    # 2) 체크리스트 진행 중 뒤로가기 → 확인창
    page.locator('button[onclick^="toggle("]').first.click(); page.wait_for_timeout(150)
    answer['v'] = False; back()
    check('점검 중 뒤로가기 → 확인창 표시', len(dialogs) == 1 and '점검 중' in dialogs[0])
    check('확인창 "취소" → 3단계 유지·체크 유지', step() == 3 and page.evaluate('Object.values(state.checked).some(Boolean)'))
    answer['v'] = True; back()
    check('확인창 "확인" → 2단계(작업 선택)', step() == 2 and len(dialogs) == 2)
    back(); check('뒤로가기 → 1단계(업종 선택)', step() == 1)
    back(); check('뒤로가기 → 홈', step() == 0)

    # 3) 체크 안 한 체크리스트는 확인창 없이 이동
    page.click('button.home-btn[onclick="go(1)"]'); page.locator('button.i-btn').first.click()
    page.locator('button.det-btn').first.click(); page.click('button.big-btn[onclick="startCheck()"]'); page.wait_for_timeout(150)
    n = len(dialogs); back()
    check('체크 0개 체크리스트 → 확인창 없이 2단계', step() == 2 and len(dialogs) == n)
    page.locator('.back-btn').first.click(); page.wait_for_timeout(100)
    page.locator('.back-btn').first.click(); page.wait_for_timeout(150)
    check('화면 왼쪽 위 "← 뒤로" 버튼 기존대로 동작', step() == 0)

    # 4) 홈: 한 번 더 누르면 종료 (안드로이드)
    back()
    check('홈에서 뒤로가기 → 앱 유지 + "한 번 더" 안내', step() == 0 and toast_on() and '한 번 더' in page.inner_text('#os-back-toast'))
    check('안내와 함께 시작 기록으로 이동(다음 뒤로가기 = 종료)', page.evaluate('_osBack.guards()') == 0)
    page.wait_for_timeout(2300)
    check('2초 지나면 안내 사라짐', not toast_on())
    page.locator('.home-btn[onclick="go(1)"]').click(); page.wait_for_timeout(200)
    check('화면을 누르면 가드 다시 5칸', step() == 1 and page.evaluate('_osBack.guards()') == 5)
    back(); check('→ 홈', step() == 0)
    back(); check('다시 안내 표시', toast_on())
    page.locator('.home-btn[onclick="go(1)"]').click(); page.wait_for_timeout(200)
    check('안내 중 화면 터치 → 종료 대기 취소, 가드 복구', not toast_on() and step() == 1 and page.evaluate('_osBack.guards()') == 5)
    back(); check('→ 홈', step() == 0)

    # 4-2) 터치 없이 가장 깊은 화면에서 연속 뒤로가기 → 앱이 꺼지지 않고 홈까지 옴
    page.locator('.home-btn[onclick="go(1)"]').click(); page.locator('button.i-btn').first.click()
    page.locator('button.det-btn').first.click(); page.click('button.big-btn[onclick="startCheck()"]'); page.wait_for_timeout(150)
    page.evaluate('go(4)'); page.wait_for_timeout(150)
    url0 = page.url; path = []
    for _ in range(4): back(); path.append(step())
    check('보고서→체크리스트→작업→업종→홈 (터치 없이 연속 4번)', path == [3, 2, 1, 0] and page.url == url0)
    back(); check('5번째 → 홈 종료 안내', toast_on() and step() == 0)
    page.wait_for_timeout(2300)

    # 5) 설정(⚙️) 팝업 / 의견 보내기 창 → 창만 닫힘
    page.locator('.gear-btn').first.click(); page.wait_for_timeout(150)
    check('설정 팝업 열림', page.evaluate("document.getElementById('gear-popup').classList.contains('open')"))
    back()
    check('뒤로가기 → 설정 팝업만 닫힘(홈 유지, 종료 안내 없음)', not page.evaluate("document.getElementById('gear-popup').classList.contains('open')") and step() == 0 and not toast_on())
    page.locator('[onclick="openFeedback()"]').first.click(); page.wait_for_timeout(200)
    check('의견 보내기 창 열림', page.locator('#fb-overlay').count() == 1)
    back()
    check('뒤로가기 → 의견 창만 닫힘', page.locator('#fb-overlay').count() == 0 and step() == 0 and not toast_on())

    # 6) 관리자 화면(5탭) → 뒤로가기로 닫힘
    page.evaluate('for(let i=0;i<5;i++)_adminTap()'); page.wait_for_timeout(250)
    page.locator('#admin-overlay').click(position={'x': 5, 'y': 5}); page.wait_for_timeout(100)
    back()
    check('관리자 PIN 화면 → 뒤로가기로 닫힘', page.locator('#admin-overlay').count() == 0 and step() == 0)

    # 7) 이력·통계·AI 채팅 → 홈
    page.locator('[onclick="go(6)"]').first.click(); page.wait_for_timeout(250)
    ok_in = step() == 6; back()
    check('이력 화면 → 뒤로가기 → 홈', ok_in and step() == 0)
    for s, label in ((7, '체감온도'), (8, '한랭 체감'), (9, '통계(구 화면)')):
        page.locator('.home-btn[onclick="go(1)"]').click(); page.wait_for_timeout(100); page.evaluate('go(0)')   # 사용자 터치 확보
        page.evaluate(f'go({s})'); page.wait_for_timeout(250)
        ok_in = step() == s; back()
        check(f'{label} 화면 → 뒤로가기 → 홈', ok_in and step() == 0)
    page.locator('.home-btn[onclick="go(1)"]').click(); page.wait_for_timeout(100)   # 사용자 터치 확보
    page.evaluate('go(5)'); page.wait_for_timeout(300)
    check('AI 채팅 진입(body chat-mode)', step() == 5 and page.evaluate("document.body.classList.contains('chat-mode')"))
    back()
    check('AI 채팅 → 뒤로가기 → 홈, chat-mode 해제', step() == 0 and not page.evaluate("document.body.classList.contains('chat-mode')"))

    # 8) 영어 모드 안내 문구
    page.evaluate("state.lang='en';render()"); page.locator('.home-btn').first.click(); page.wait_for_timeout(100)
    back(); back()
    check('영어 모드 종료 안내 문구', 'Press back again' in page.inner_text('#os-back-toast'))
    page.wait_for_timeout(2300)

    # 9) 홈에서 2초 안에 두 번 → 앱 밖으로 나감(=실기기에서는 종료)
    page.evaluate("state.lang='ko';render()"); page.locator('.home-btn').first.click(); page.wait_for_timeout(100); back()
    check('(준비) 홈', step() == 0)
    url0 = page.url
    page.go_back(); page.wait_for_timeout(200); page.go_back(); page.wait_for_timeout(400)
    check('2초 안에 두 번 → 앱을 벗어남(실기기: 종료)', page.url != url0)

    check('전체 흐름 동안 JS 예외 없음(안드로이드)', not errors)
    if errors: print('  예외:', errors[:5])

    # 10) 아이폰 — 뒤로 스와이프(=history back) 동작, 홈에서는 종료 안내 없음
    ictx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
    ip = ictx.new_page(); ierr = []
    ip.on('pageerror', lambda e: ierr.append(str(e)))
    ip.on('dialog', lambda d: d.accept())
    for pat in ('**/*.workers.dev/**', '**/api.open-meteo.com/**', '**/api.bigdatacloud.net/**'):
        ip.route(pat, lambda r, q: r.fulfill(status=200, body='{}', headers=JSON))
    ip.route('**/www.googletagmanager.com/**', lambda r, q: r.fulfill(status=200, body='', headers={'Content-Type': 'text/javascript'}))
    ip.goto(f'http://127.0.0.1:{PORT}/{PAGE}', wait_until='load'); ip.wait_for_timeout(1000)
    ist = lambda: ip.evaluate('state.step'); iback = lambda: (ip.go_back(), ip.wait_for_timeout(250))
    check('아이폰 판정(IS_IOS=true)', ip.evaluate('_osBack.isIOS') is True)
    ip.click('button.home-btn[onclick="go(1)"]'); ip.locator('button.i-btn').first.click(); ip.wait_for_timeout(150)
    iback(); check('아이폰 스와이프: 작업 선택 → 업종 선택', ist() == 1)
    iback(); check('아이폰 스와이프: 업종 선택 → 홈', ist() == 0)
    iback(); check('아이폰 홈에서 스와이프 → 종료 안내 없음·홈 유지', ist() == 0 and not ip.evaluate("!!document.querySelector('#os-back-toast.show')"))
    ip.go_forward(); ip.wait_for_timeout(250)
    check('아이폰 앞으로 스와이프 → 무시(화면 그대로)', ist() == 0)
    check('아이폰 흐름 JS 예외 없음', not ierr)
    ictx.close()
    browser.close()

ok = all(r for _, r in results)
print(f'\n뒤로가기 테스트 {sum(r for _, r in results)}/{len(results)} 통과')
sys.exit(0 if ok else 1)
