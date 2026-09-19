# tools — 법령 DB(law_kb.json) 빌드·검증 도구

앱 실행에는 쓰이지 않는다. `law_kb.json`을 만들고 배포 전에 검증하기 위한 개발용 스크립트다.
필요 환경: Python 3 (외부 패키지 없음)

## 왜 필요한가

`law_kb.json`은 산업안전보건법·시행령·시행규칙·산안규칙 1,227개 조문과 별표 13종을 담은 검색용 DB다.
Cloudflare Worker가 사용자 질문에 맞는 조문을 골라 AI 프롬프트에 근거로 넣는 데 쓴다.

초기 버전은 검증 없이 배포되어 조문 오염(법 제1·40·51·63조, 산안규칙 제2조)이 그대로 서비스됐다.
`validate_kb.py`는 그 재발을 막기 위한 것으로, 오류가 있으면 종료코드 1을 반환한다.

## 파이프라인

```
별표 HWPX ──► build_annex.py ──► annex_chunks.json ──┐
                                                      ├─► build_kb.py ──► law_kb.v2.json ──► validate_kb.py
                          기존 law_kb.json ───────────┘
```

### 1. `hwpx_extract.py` — HWPX 추출기
한글 별표 파일에서 본문과 표를 구조를 유지한 채 뽑는다.

- 병합 셀은 `cellAddr`/`cellSpan`을 읽어 행×열로 복원
- `<hp:fwSpace/>`(고정폭 공백)가 `<hp:t>` 안에 자식으로 들어가면 그 뒤 텍스트가 `tail`에 가는데,
  이를 놓치면 글자가 통째로 사라진다. (실제로 "13. 컨베이어등을 사용하여"가 "13.용하여"로 잘렸음)

단독 실행: `python3 hwpx_extract.py 파일.hwpx` → 마크다운 표로 출력

### 2. `build_annex.py` — 별표 → 검색 청크
```bash
python3 tools/build_annex.py [별표폴더]     # 폴더 생략 시 tools/annex_src
```
- 소제목(1. / 가. / 1)) 단위로 묶고 1,400자를 넘으면 분할
- HWPX가 표 전체를 첫 셀에 한 번 더 담는 "요약 덩어리"는 버린다
  (안 버리면 개별 행이 중복으로 몰려 삭제되고 거대 덩어리 하나만 남는다)
- 결과: `annex_chunks.json`

### 3. `build_kb.py` — KB 정비
```bash
python3 tools/build_kb.py                   # law_kb.json + annex_chunks.json → law_kb.v2.json
```
- 공백·문장부호 정규화 (" ." → ".", "제 3 자" → "제3자")
- 마지막 조문이 흡수한 부칙·별표 목차 꼬리 절단
- 파싱이 깨진 조문에 `bad` 표시 → Worker가 검색에서 제외
- **조문 내용을 새로 만들거나 추측해 채우지 않는다.** 정규화·절단·표시만 한다.

`BAD` 목록은 원본 재생성 전까지의 임시 조치다. 법제처 Open API XML로 KB를 다시 만들면 이 목록을 비운다.

### 4. `validate_kb.py` — 배포 전 검증
```bash
python3 tools/validate_kb.py law_kb.json    # 오류 있으면 종료코드 1
```
검사 항목: 본문이 자기 조번호로 시작하는지 / 제목과 본문 괄호 제목 일치 / 부칙 혼입 /
중복 조번호 / 결번 / 별표 참조↔수록 대조 / 청크 번호 연속성 / 공백 노이즈 잔존

## 별표를 추가할 때

1. law.go.kr에서 별표를 HWP/HWPX로 내려받아 `tools/annex_src/`에 넣는다
2. `python3 tools/build_annex.py`
3. `python3 tools/build_kb.py`
4. `python3 tools/validate_kb.py law_kb.v2.json` → ✅ 나오면 `law_kb.v2.json`을 `law_kb.json`으로 교체
5. `node tests/test_retrieve.js`로 검색 결과 확인
6. Worker의 `LAW_DIRECT`에 새 별표 직결 키 추가 (예: `'교육시간': ['sanan_rule:별표4']`)
