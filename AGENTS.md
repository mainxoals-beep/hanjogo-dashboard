# 작업 규칙 (Claude · ChatGPT · 사람 공통)

이 저장소는 여러 AI 도구가 번갈아 수정합니다. 아래 규칙을 지켜야 서로의 작업을 덮어쓰지 않습니다.

## 구성
- `index.html`: 준비위원 전용 내부 대시보드 (로그인 필요)
- `schedule.html`: 동문 공개 페이지
- `alumni-map.html`: 동문 매장 지도
- `assets/raffle-roster.js`: 추첨 명단 로직 (`tests/`에서 테스트)
- `supabase/`: Supabase 프로젝트 `siuresrjvrrezhwsjery` 관련 코드와 DB 변경 기록
- 배포: `main` 브랜치에 push하면 GitHub Pages(`mainxoals-beep.github.io/hanjogo-dashboard`)에 반영됩니다.

## 작업 순서
1. 시작 전 항상 최신 `main`을 받습니다. 동시에 두 도구가 같은 파일을 고치지 않습니다.
2. 작업이 끝나면 바로 커밋하고 push합니다. 로컬에 미반영 변경을 남기지 않습니다.
3. 커밋은 한 가지 목적만 담고, 메시지에 무엇을 왜 바꿨는지 적습니다.
4. push 전에 `node tests/<파일>.cjs`로 관련 테스트를 실행합니다.

## Supabase DB 변경 규칙
- DB 구조·정책·함수를 바꾸면 **같은 SQL을 `supabase/migrations/<버전>_<이름>.sql`로 커밋**합니다.
  저장소만 보고 현재 DB 상태를 알 수 있어야 다른 도구가 안전하게 이어서 작업할 수 있습니다.
- SQL 파일에 비밀값(cron 토큰, service role 키 등)이나 개인정보(이메일 목록, 전화번호)를 넣지 않습니다.
- 운영 DB에 바로 적용되므로, 기존 동작을 깨지 않는 "추가" 변경을 먼저 하고, 막는 변경은 화면 배포 후에 합니다.

## 보안 규칙 (반드시 지킬 것)
자세한 내용은 `supabase/SECURITY.md`를 봅니다.
- `dashboard_state`(내부 데이터: 참가자 연락처, 예산, 계좌)는 **편집자만** 읽고 쓸 수 있어야 합니다.
  `anon`에게 이 테이블 권한이나 정책을 다시 열지 않습니다.
- 공개 페이지는 `public_dashboard_state` 테이블과 `get_hanjogo_public_dashboard()`,
  `get_hanjogo_story_raffle()` 함수만 사용합니다. 공개 페이지에서 `dashboard_state`를 직접 읽지 않습니다.
- 내부 대시보드 로그인은 Supabase Auth 공용 계정으로 합니다. 비밀번호나 해시를 코드에 넣지 않습니다.
- `index.html`의 Supabase 클라이언트 `sb`(공용 계정)와 `sbAdmin`(관리자)을 하나로 합치지 않습니다. 이유는 `supabase/SECURITY.md`에 있습니다.
- 편집자 추가·삭제는 `public.hanjogo_dashboard_editors` 테이블에서 합니다.
