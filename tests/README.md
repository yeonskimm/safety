# tests — 배포 전 검증

저장소 루트에서 한 번에:

```bash
bash tests/run_all.sh
```

아래 순서로 검사하고, 하나라도 실패하면 종료코드 1을 반환한다(→ 배포 중단).

| 순서 | 검사 | 내용 |
|---|---|---|
| 1 | 문법 검사 | `worker.js` · `service-worker.js` |
| 2 | 법령 KB 구조 검증 | `tools/validate_kb.py law_kb.json` |
| 3 | 법령 검색 회귀 | 58문항 (`test_retrieve.js`) |
| 4 | 답변 조문번호 검증 | 19항목 (`test_verify.js`) |
| 5 | 관리자 인증 단위 | 세션토큰·PIN 비교 (`test_admin.js`) |
| 5-2 | AI 프록시 보호 통합 | 18항목 (`test_proxy.mjs`) |
| 6 | 버전 동기화 | `index.html` APP_VERSION ↔ `service-worker.js` CACHE_NAME |
| 6-2 | 법령 KB 캐시키 동기화 | `worker.js` LAW_KB_VER ↔ `law_kb.json` 빌드버전 |
| 6-3 | 캐시 삭제 범위 | 자기 접두어(`onul-safety-`) 캐시만 삭제 — 같은 주소의 법ON 저장본 보호 |
| 7 | 평문 비밀값 잔존 | `index.html`에 PIN 등 평문이 없는지 |
| 8 | 렌더링 (Playwright) | 17항목 (`test_ui.py`) |
| 9 | 개인정보 안내 (Playwright) | 25항목 (`test_privacy.py`) |
| 10 | 안드로이드 뒤로가기 (Playwright) | 43항목 (`test_backnav.py`) |

Playwright가 설치되지 않은 환경에서는 8~10번을 건너뛴다(배포 전에는 반드시 설치 후 실행).

## 개별 실행

| 파일 | 대상 | 실행 |
|---|---|---|
| `test_retrieve.js` | 법령 검색 정확도 (58문항) | `node tests/test_retrieve.js` |
| `test_verify.js` | 답변 조문번호 검증 (lawVerify, 19항목) | `node tests/test_verify.js` |
| `test_admin.js` | 관리자 세션토큰·PIN 비교 | `node tests/test_admin.js` |
| `test_proxy.mjs` | AI 프록시 보호: 서버 고정 시스템 프롬프트, 답변 길이·온도 상한, IP당 요청 한도, 잘못된 요청 차단 (18항목) | `node tests/test_proxy.mjs` |
| `test_ui.py` | 홈 렌더링·관리자 인증 흐름 (Playwright, 17항목) | `python3 tests/test_ui.py` |
| `test_privacy.py` | 개인정보 안내: 의견 보내기 동의·접힘 안내, AI 채팅 안내문 (Playwright, 25항목) | `python3 tests/test_privacy.py` |
| `test_backnav.py` | 안드로이드 뒤로가기 / 아이폰 적용 제외 확인 (Playwright, 43항목) | `python3 tests/test_backnav.py` |

`test_retrieve.js` / `test_verify.js` / `test_admin.js` / `test_proxy.mjs`는 **`worker.js`의 코드를 그대로 읽어 실행한다.**
테스트용 사본을 따로 두지 않으므로, 배포 파일과 검증 대상이 항상 일치한다.
(`worker.js`의 `// ── LAW_RETRIEVAL_BEGIN ──` ~ `// ── LAW_RETRIEVAL_END ──` 마커를 지우면 안 된다)

## Playwright 준비

```bash
pip install playwright && playwright install chromium
```

Worker 응답은 전부 모킹하므로 실제 서버·API 키가 없어도 돌아간다.
스크립트 안의 PIN은 **테스트 전용 더미 값**이며, 실제 관리자 PIN은 Cloudflare Worker의
Secret(`ADMIN_PIN`)에만 존재하고 이 저장소 어디에도 없다.

`test_ui.py`를 실행하면 `shot_*.png` 스크린샷이 생성된다. 커밋할 필요는 없다.

## 신·구 비교

구버전 KB를 함께 두면 검색 정확도 개선폭을 표로 보여준다.

```bash
KB_OLD=law_kb.old.json node tests/test_retrieve.js
```
