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

## 번개·소모임 (`schedule.html` > 모임)
- `hanjogo_meetups`, `hanjogo_meetup_attendees`, `hanjogo_meetup_comments`에는 `anon`·`authenticated` 권한을 주지 않습니다.
  `hanjogo-access` 함수만 읽고 쓰며, 동문 인증한 사람만 볼 수 있습니다.
- 목록에는 표시 이름(프로필의 이름 표시 방식 적용)과 기수만 나갑니다. **참석자 이메일은 그 모임 주최자에게만** 보냅니다.
- 취소: 주최자 말고 신청한 사람이 없으면 행을 지웁니다. 있으면 `status='cancelled'`로 남기고, 모임 날짜가 지나면 목록에서 뺍니다.
- 정원 확인은 `hanjogo_meetup_join()` 함수가 모임 행을 잠그고 합니다(동시에 눌러도 정원 초과 없음). service role만 실행합니다.

## 선후배 질문 · 실무 자료실 (`schedule.html` > 게시판 '선후배 질문', 자료실)
- 선후배 질문은 게시판(`hanjogo_board_posts`)의 `question` 분류입니다. 질문 글에만 `topic`(도움 분야)과 `is_resolved`가 붙습니다.
- 도와줄 수 있는 동문 목록과 @태그 후보는 **공개 프로필(동의 + 이름 비공개 아님)** 만 씁니다. 사이트에서 고른 분야에 더해,
  구글 폼 "연결 희망 분야"를 **공개 항목으로 고른 경우에만** 그 답(창업, 메뉴개발/R&D, 해외 취업/유학, 식자재/유통, 교육/강의)을 분야로 봅니다.
  이메일은 서버 안에서 알림을 보낼 때만 쓰고 화면으로 보내지 않습니다.
- 알림(`hanjogo_notifications`)은 `anon`·`authenticated` 권한이 없고, 함수가 로그인한 본인 것만 보여줍니다.
- `hanjogo_resources`, `hanjogo_resource_comments`에는 `anon`·`authenticated` 권한을 주지 않습니다.
  `hanjogo-access` 함수만 읽고 쓰며, 동문 인증한 사람만 봅니다. 목록에는 표시 이름과 기수만 나갑니다(이메일 없음).
- "도와줄 수 있는 분야"(`hanjogo_profile_overrides.help_topics`)는 공개를 목적으로 고르는 항목입니다.
  **프로필 공개(consent)에 동의한 사람만** 다른 동문에게 보이고, 이름은 그 사람의 이름 표시 방식을 따릅니다.
- 자료 파일은 비공개 저장소 `hanjogo-resources`에 둡니다. 저장소 정책을 만들지 않습니다(함수만 접근).
  올릴 때는 함수가 만든 일회용 주소로, 받을 때는 5분짜리 주소로만 접근합니다. 파일은 올린 사람 폴더(`<user_id>/`) 아래 무작위 이름으로 저장하고,
  다른 사람 폴더의 파일을 자기 자료로 등록하지 못하게 함수가 확인합니다. 10MB, 정해진 확장자만 받습니다.

## 동문 업장 (`alumni-map.html`, `schedule.html` > 내 정보)
- `hanjogo_alumni_places`의 공개 읽기에는 **`owner_email`을 넣지 않습니다**. 담당자 이메일이 외부로 나갑니다.
  컬럼 단위로 select 권한을 주고 있으므로, 화면에서 `select('*')`를 쓰지 않습니다.
- 담당자 연결(`owner_email`)은 그 업장을 수정할 수 있다는 뜻입니다. 관리자만 바꿉니다.
  이름+기수 자동 매칭은 **제안까지만** 하고, 같은 기수 동명이인은 제안하지 않습니다.
- 지도의 "이메일로 연락" 버튼은 서버 함수(`place_contacts`)가 **이메일 연락을 허용한 사장님만** 골라 동문 인증한 사람에게만 알려줍니다.
  허용 여부는 사이트 프로필 → 연락 동의 표 → 프로필 폼 답변 순서로 봅니다. 허용하지 않은 사장님 이메일은 서버 밖으로 나가지 않습니다.
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
