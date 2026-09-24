#!/usr/bin/env bash
# run_all.sh — 배포 전 전체 검증. 저장소 루트에서 실행: bash tests/run_all.sh
# 하나라도 실패하면 종료코드 1 → 배포하지 말 것.
set -u
cd "$(dirname "$0")/.."
FAIL=0
step() { echo; echo "── $1"; shift; "$@" || { echo "❌ 실패"; FAIL=1; }; }

step "1) 문법 검사 (worker.js / service-worker.js)" bash -c 'node --check worker.js && node --check service-worker.js && echo "문법 OK"'
step "2) 법령 KB 구조 검증" python3 tools/validate_kb.py law_kb.json
step "3) 법령 검색 회귀 테스트" node tests/test_retrieve.js
step "4) 답변 조문번호 검증 테스트" node tests/test_verify.js
step "5) 관리자 인증 단위 테스트" node tests/test_admin.js
step "5-2) AI 프록시 보호 통합 테스트" node tests/test_proxy.mjs
step "6) 버전 동기화 (APP_VERSION ↔ CACHE_NAME)" python3 - <<'PY'
import re,sys
v=re.search(r"APP_VERSION='(v\d+)'",open('index.html',encoding='utf-8').read()).group(1)
c=re.search(r"onul-safety-(v\d+)",open('service-worker.js',encoding='utf-8').read()).group(1)
print(f"index.html {v} / service-worker.js {c}")
sys.exit(0 if v==c else 1)
PY
step "6-2) 법령 KB 캐시키 동기화 (worker LAW_KB_VER ↔ KB 빌드버전)" python3 - <<'PY'
import re,json,sys
w=re.search(r"LAW_KB_VER = '([\d.]+)'",open('worker.js',encoding='utf-8').read()).group(1)
k=json.load(open('law_kb.json',encoding='utf-8'))['meta']['빌드버전'].lstrip('v')
print(f"worker {w} / KB {k}")
sys.exit(0 if w==k else 1)
PY
step "6-3) 캐시 삭제 범위 (자기 접두어 onul-safety- 만 삭제)" python3 - <<'PY'
import re,sys
s=open('service-worker.js',encoding='utf-8').read()
ok=("CACHE_PREFIX = 'onul-safety-'" in s) and bool(re.search(r"filter\(k => k\.startsWith\(CACHE_PREFIX\) && k !== CACHE_NAME\)",s)) and not re.search(r"filter\(k => k !== CACHE_NAME\)",s)
print("자기 캐시만 삭제" if ok else "다른 앱 캐시까지 삭제하는 코드가 있음 — 법ON 저장본이 지워짐")
sys.exit(0 if ok else 1)
PY
step "7) 평문 비밀값 잔존 검사" bash -c '! grep -nE "safety-admin-[0-9]+|ADMIN_PIN *= *.[0-9]{6}" index.html && echo "평문 잔존 없음"'


echo
if command -v python3 >/dev/null && python3 -c "import playwright" 2>/dev/null; then
  step "8) 렌더링 테스트 (Playwright)" python3 tests/test_ui.py
  step "9) 개인정보 안내 테스트 (Playwright)" python3 tests/test_privacy.py
else
  echo "── 8) 렌더링 테스트 건너뜀 (playwright 미설치: pip install playwright && playwright install chromium)"
fi

echo
[ $FAIL -eq 0 ] && echo "✅ 전체 통과 — 배포 가능" || echo "❌ 실패 항목 있음 — 배포 중단"
exit $FAIL
