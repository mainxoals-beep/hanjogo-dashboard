# Supabase 보안 구조

## 내부 대시보드 (`index.html`)
- 데이터: `public.dashboard_state` (id = `main` 한 행, JSON)
- 로그인: Supabase Auth 이메일+비밀번호. 준비위원은 공용 계정 `mainxoals+hanjogo-committee@gmail.com`을 씁니다.
  화면에서는 비밀번호만 입력하고, 입력값은 소문자로 바꿔 전송합니다(기존 비밀번호 화면과 같은 동작).
  관리자는 기존처럼 이메일 링크(OTP)로 로그인해도 됩니다.
- 로그인 저장 공간이 둘입니다. 하나로 합치지 않습니다.
  - `sb`: 공용 계정 전용(`storageKey: hanjogo-dashboard-committee-auth`). 대시보드 데이터 읽기·쓰기.
  - `sbAdmin`: 관리자(mainxoals) 로그인. 공개 페이지·동문 지도와 같은 저장 공간을 공유합니다. 추첨, 배분표, 특별 접근 관리에 씁니다.
  - 합치면 공용 계정 로그인이 관리자 로그인을 덮어써서 공개 페이지 인증이 풀리고 추첨이 막힙니다.
  - 잠금 버튼은 `signOut({scope:"local"})`만 씁니다. 그냥 `signOut()`은 공용 계정을 쓰는 모든 준비위원을 로그아웃시킵니다.
- 권한: `public.is_hanjogo_dashboard_editor()`가 로그인 이메일이 `public.hanjogo_dashboard_editors`에 있는지 확인합니다.
  `dashboard_state`의 읽기·쓰기 정책은 이 함수가 true일 때만 허용합니다.
- 비밀번호 변경: Supabase 대시보드 > Authentication > Users > 공용 계정 > 비밀번호 변경 (소문자로 설정).

## 공개 페이지 (`schedule.html`)
- `get_hanjogo_public_dashboard()`, `get_hanjogo_story_raffle()`: SECURITY DEFINER.
  `dashboard_state`에서 공개해도 되는 값만 골라 반환합니다. 새 필드를 추가할 때 개인정보가 섞이지 않게 합니다.
- 실시간 갱신은 `public_dashboard_state` 변경을 구독합니다(`dashboard_state`가 바뀌면 트리거가 함께 갱신).

## 동문 프로필 (`schedule.html` > 내 정보)
- 원본은 구글 폼 시트(CSV)입니다. 동문이 사이트에서 고치면 `public.hanjogo_profile_overrides`에 저장하고,
  **저장된 행이 있으면 그 내용이 폼보다 우선**합니다. 같은 사람이 폼을 다시 제출해도 사이트 내용이 유지됩니다.
- 이 표에는 `anon`·`authenticated` 권한을 주지 않습니다. `hanjogo-access` 함수(service role)만 읽고 씁니다.
- 공개 범위는 서버가 정합니다. `public_fields`에 없는 항목은 목록 응답에 아예 담기지 않습니다.
  화면에서 숨기는 방식으로 처리하지 않습니다. `tests/profile.test.cjs`가 이를 확인합니다.
- `consent`가 false면 공개 목록에 나오지 않습니다. 이름 표시는 `display_mode`(full/masked/hidden)를 따릅니다.

## 즐겨찾기 (관심 동문 · 관심 업장)
- `public.hanjogo_favorites`에 계정별로 저장해 기기 간에 따라다닙니다.
  `anon`·`authenticated` 권한을 주지 않습니다. `hanjogo-access` 함수만 읽고 쓰며, **항상 로그인한 본인 이메일 것만** 다룹니다.
- 담는 값은 동문 프로필 id(이메일 해시)와 업장 번호뿐입니다. 이름·이메일을 넣지 않습니다.
- 로그인하지 않은 사람은 브라우저에만 저장됩니다. 인증하면 그 목록을 계정으로 한 번 옮깁니다.
- 화면은 브라우저 저장본을 먼저 보여주고 서버 값으로 맞춥니다. 서버 저장이 실패하면 별을 되돌립니다.

## 동문 업장 (`alumni-map.html`, `schedule.html` > 내 정보)
- `hanjogo_alumni_places`의 공개 읽기에는 **`owner_email`을 넣지 않습니다**. 담당자 이메일이 외부로 나갑니다.
  컬럼 단위로 select 권한을 주고 있으므로, 화면에서 `select('*')`를 쓰지 않습니다.
- 담당자 연결(`owner_email`)은 그 업장을 수정할 수 있다는 뜻입니다. 관리자만 바꿉니다.
  이름+기수 자동 매칭은 **제안까지만** 하고, 같은 기수 동명이인은 제안하지 않습니다.
- 등록 신청·운영자 인증 요청 승인은 관리자(`mainxoals`)만 할 수 있습니다. 대시보드 > 시스템 설정에 있습니다.

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

## 방문 통계 (구글 애널리틱스)
- `assets/analytics.js`를 `schedule.html`, `alumni-map.html`에서만 불러옵니다. 내부 대시보드(`index.html`)에는 넣지 않습니다.
- 구글에는 주소의 `?`·`#` 뒤를 잘라낸 페이지 주소만 보냅니다. 이메일 로그인 링크에 인증 정보가 붙어 오기 때문입니다.
  이름·이메일·프로필 값을 이벤트로 보내지 않습니다.
- `schedule.html`의 보안 설정(CSP)에 `googletagmanager.com`, `google-analytics.com`이 허용돼 있습니다. 이 둘 외에는 넓히지 않습니다.
