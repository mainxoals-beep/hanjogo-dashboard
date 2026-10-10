# 일괄 추첨 검증

화면 타이밍 및 기존 단일 추첨 회귀:

```sh
node tests/raffle-batch.test.cjs
node tests/raffle.test.cjs
node tests/raffle-countdown.test.cjs
```

DB 검증은 운영 DB가 아닌 별도의 PGlite PostgreSQL에서 실행합니다.
`@electric-sql/pglite@0.3.14`를 임시 디렉터리에 설치하고, 현재
`raffle_private.draw(text,text,text,text,boolean,text[])`의 정의를 읽기 전용으로
내보낸 임시 SQL 파일을 사용합니다. 비공개 함수 정의를 저장소에 올리지 않습니다.

```sh
PGLITE_MODULE=/tmp/hanjogo-raffle-test/node_modules/@electric-sql/pglite \
RAFFLE_SELECTOR_SQL=/tmp/hanjogo-current-private-selector.sql \
node tests/raffle-batch-db.test.cjs
```

가상 참가자로 배분표 병합, 다중 당첨·수량 저장, 중간 실패 전체 취소,
테스트 모드 무저장, 응답 재시도, 일시정지와 공개 제어 버전 충돌,
관리자 권한과 익명 실행 차단을 확인합니다. 운영 DB 마이그레이션은 사용자 승인 후 별도로 실행합니다.
