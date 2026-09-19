# tests — 배포 전 검증

저장소 루트에서 한 번에:

```bash
bash tests/run_all.sh
```

문법 검사 → KB 검증 → 법령 검색 회귀 → 답변 검증 → 관리자 인증 → 버전 동기화 →
평문 비밀값 잔존 검사 → 렌더링 테스트를 차례로 돌리고, 하나라도 실패하면 종료코드 1을 반환한다.

## 개별 실행

| 파일 | 대상 | 실행 |
|---|---|---|
| `test_retrieve.js` | 법령 검색 정확도 (47문항) | `node tests/test_retrieve.js` |
| `test_verify.js` | 답변 조문번호 검증 (lawVerify) | `node tests/test_verify.js` |
| `test_admin.js` | 관리자 세션토큰·PIN 비교 | `node tests/test_admin.js` |
| `test_ui.py` | 관리자 인증 흐름 렌더링 (Playwright) | `python3 tests/test_ui.py` |

`test_retrieve.js` / `test_verify.js` / `test_admin.js`는 **`worker.js`의 해당 코드 구간을 그대로 읽어 실행한다.**
테스트용 사본을 따로 두지 않으므로, 배포 파일과 검증 대상이 항상 일치한다.
(`worker.js`의 `// ── LAW_RETRIEVAL_BEGIN ──` ~ `// ── LAW_RETRIEVAL_END ──` 마커를 지우면 안 된다)

## test_ui.py 준비

```bash
pip install playwright && playwright install chromium
```

Worker 응답은 전부 모킹하므로 실제 서버·API 키가 없어도 돌아간다.
스크립트 안의 PIN은 **테스트 전용 더미 값**이며, 실제 관리자 PIN은 Cloudflare Worker의
Secret(`ADMIN_PIN`)에만 존재하고 이 저장소 어디에도 없다.

실행하면 `shot_*.png` 스크린샷이 생성된다. 커밋할 필요는 없다.

## 신·구 비교

구버전 KB를 함께 두면 검색 정확도 개선폭을 표로 보여준다.

```bash
KB_OLD=law_kb.old.json node tests/test_retrieve.js
```
