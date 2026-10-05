# Supabase 보안 구조

## 내부 대시보드 (`index.html`)
- 데이터: `public.dashboard_state` (id = `main` 한 행, JSON)
- 로그인: Supabase Auth 이메일+비밀번호. 준비위원은 공용 계정 `mainxoals+hanjogo-committee@gmail.com`을 씁니다.
  화면에서는 비밀번호만 입력하고, 입력값은 소문자로 바꿔 전송합니다(기존 비밀번호 화면과 같은 동작).
  관리자는 기존처럼 이메일 링크(OTP)로 로그인해도 됩니다.
- 권한: `public.is_hanjogo_dashboard_editor()`가 로그인 이메일이 `public.hanjogo_dashboard_editors`에 있는지 확인합니다.
  `dashboard_state`의 읽기·쓰기 정책은 이 함수가 true일 때만 허용합니다.
- 비밀번호 변경: Supabase 대시보드 > Authentication > Users > 공용 계정 > 비밀번호 변경 (소문자로 설정).

## 공개 페이지 (`schedule.html`)
- `get_hanjogo_public_dashboard()`, `get_hanjogo_story_raffle()`: SECURITY DEFINER.
  `dashboard_state`에서 공개해도 되는 값만 골라 반환합니다. 새 필드를 추가할 때 개인정보가 섞이지 않게 합니다.
- 실시간 갱신은 `public_dashboard_state` 변경을 구독합니다(`dashboard_state`가 바뀌면 트리거가 함께 갱신).

## 서버 함수
- `hanjogo-access`: 동문 인증, 게시판, 프로필 (JWT 검증, 관리자 확인은 서버에서)
- `refresh-participant-count`: 1분마다 cron이 호출, service role로 참가자 수 갱신. 소스에 cron 토큰이 있어 저장소에 넣지 않습니다.

## 적용 순서 (2026-10 잠금 작업)
1. `migrations/20261005150000_dashboard_editor_access.sql` — 추가만 하는 변경. 기존 화면 그대로 동작.
2. Supabase Auth에 공용 계정 생성 (Auto Confirm, 소문자 비밀번호).
3. 화면 변경(`index.html` 로그인, `schedule.html` 구독 대상) 배포 후, 준비위원이 로그인·수정 가능한지 확인.
4. `migrations/20261005150100_lock_dashboard_state.sql` — 익명 접근 차단.
5. 문제가 생기면 `rollback/20261005150100_lock_dashboard_state.down.sql`로 4번만 되돌립니다.

### 진행 상태 (작업할 때마다 갱신)
- [x] 1번 — 2026-10-05 적용 (SQL Editor에서 실행)
- [x] 2번 — 2026-10-05 공용 계정 생성
- [x] 3번 — 2026-10-05 main 반영, 공용 계정 로그인·저장 확인
- [x] 4번 — 2026-10-05 적용 (SQL Editor에서 실행). 익명 접근 차단 완료, 공개 함수는 익명으로 정상 동작 확인.
