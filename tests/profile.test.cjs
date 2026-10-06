// 서버 함수(hanjogo-access)의 프로필·업장 입력 검증과 공개 변환 테스트.
// 여기서 통과한 값이 그대로 공개 사이트에 노출되므로, 공개 범위를 꼼꼼히 확인합니다.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');

const source = fs.readFileSync('supabase/functions/hanjogo-access/index.ts', 'utf8');
// Deno 전용 import 와 서버 핸들러를 뺀 순수 함수 부분만 떼어내 불러옵니다.
const body = source.slice(source.indexOf('function normalizeEmail'), source.indexOf('Deno.serve('));
assert(body.length > 1000, '함수 본문을 찾지 못했습니다');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hanjogo-profile-'));
const file = path.join(dir, 'helpers.ts');
fs.writeFileSync(file, body + '\nexport { cleanProfileDraft, cleanPlaceInput, safeLink, buildProfileFromDraft, profileDraftFromOverride, maskName, alumniName, cleanMeetupInput, cleanHelpTopics, boardTopic, cleanResourceInput, helpTopicsFor, cleanMentions, resourceExtension };\n');

const baseDraft = {
  name: '김태민', generation: 2, displayMode: 'masked',
  publicFields: ['gen', 'company', 'work', 'activity', 'region', 'instagram', 'bio', 'connect'],
  company: '렁팡스', work: '요리', activity: '외식업', region: '서울',
  instagram: '@kcas_archived', bio: '소개', connect: '협업',
  allowEmailContact: true, attendeeVisible: true, consent: true,
};

(async () => {
  const H = await import('file://' + file);

  // ---- 입력 검증 ----------------------------------------------------------
  const ok = H.cleanProfileDraft({ ...baseDraft });
  assert(!('error' in ok), '정상 입력이 거부되었습니다');
  assert.equal(ok.name, '김태민');
  assert.equal(ok.generation, 2);
  assert.deepEqual(ok.publicFields, baseDraft.publicFields);

  // 잘못된 값은 저장하지 않습니다.
  assert.equal(H.cleanProfileDraft({ ...baseDraft, displayMode: 'everything' }).error, 'invalid_display_mode');
  assert.equal(H.cleanProfileDraft({ ...baseDraft, generation: 0 }).error, 'invalid_generation');
  assert.equal(H.cleanProfileDraft({ ...baseDraft, generation: 100 }).error, 'invalid_generation');
  assert.equal(H.cleanProfileDraft({ ...baseDraft, name: '  ' }).error, 'name_required');
  // 공개에 동의하지 않으면 이름이 없어도 저장할 수 있습니다(비공개 상태 유지).
  assert(!('error' in H.cleanProfileDraft({ ...baseDraft, name: '', consent: false })));
  // 기수는 비워둘 수 있습니다.
  assert.equal(H.cleanProfileDraft({ ...baseDraft, generation: null }).generation, null);
  assert.equal(H.cleanProfileDraft({ ...baseDraft, generation: '' }).generation, null);
  assert.equal(H.cleanProfileDraft({ ...baseDraft, generation: '7기' }).generation, 7);

  // 인스타그램은 주소나 아이디만 받습니다.
  assert.equal(H.cleanProfileDraft({ ...baseDraft, instagram: 'javascript:alert(1)' }).error, 'invalid_instagram');
  assert.equal(H.cleanProfileDraft({ ...baseDraft, instagram: 'http://evil.example.com/a' }).error, 'invalid_instagram');
  assert(!('error' in H.cleanProfileDraft({ ...baseDraft, instagram: '' })));
  assert(!('error' in H.cleanProfileDraft({ ...baseDraft, instagram: 'https://www.instagram.com/kcas_archived/' })));

  // 모르는 공개 항목은 버립니다. 긴 글은 잘라냅니다.
  assert.deepEqual(H.cleanProfileDraft({ ...baseDraft, publicFields: ['gen', 'email', 'phone', '__proto__'] }).publicFields, ['gen']);
  assert.deepEqual(H.cleanProfileDraft({ ...baseDraft, publicFields: 'gen' }).publicFields, []);
  assert.equal(H.cleanProfileDraft({ ...baseDraft, bio: 'ㄱ'.repeat(5000) }).bio.length, 1000);
  assert.equal(H.cleanProfileDraft({ ...baseDraft, name: '김'.repeat(100) }).name.length, 40);
  // 체크 상자는 참/거짓으로만 저장합니다.
  assert.equal(H.cleanProfileDraft({ ...baseDraft, allowEmailContact: 'yes' }).allowEmailContact, true);
  assert.equal(H.cleanProfileDraft({ ...baseDraft, allowEmailContact: undefined }).allowEmailContact, false);

  // ---- 공개 변환: 선택하지 않은 항목은 절대 나가지 않습니다 ----------------
  const full = await H.buildProfileFromDraft(H.cleanProfileDraft({ ...baseDraft }), 'a@b.com', '', '2026-10-05', 'other@b.com');
  assert.equal(full.name, '김○민');
  assert.equal(full.actualName, '', '마스킹인데 실명이 함께 나갔습니다');
  assert.equal(full.gen, '2');
  assert.equal(full.email, 'a@b.com');
  assert.equal(full.instagram.url, 'https://www.instagram.com/kcas_archived/');
  assert.equal(full.isOwnProfile, false);

  const hidden = await H.buildProfileFromDraft(
    H.cleanProfileDraft({ ...baseDraft, displayMode: 'hidden', publicFields: [], allowEmailContact: false }),
    'a@b.com', '', '2026-10-05', 'a@b.com');
  assert.equal(hidden.name, '이름 비공개');
  assert.equal(hidden.actualName, '');
  for (const key of ['gen', 'company', 'work', 'activity', 'region', 'bio', 'connect', 'email']) {
    assert.equal(hidden[key], '', key + ' 이(가) 공개 설정과 다르게 노출되었습니다');
  }
  assert.equal(hidden.instagram, null);
  assert.equal(hidden.isOwnProfile, true);

  // 실명 공개를 고른 경우에만 실명이 나갑니다.
  const named = await H.buildProfileFromDraft(H.cleanProfileDraft({ ...baseDraft, displayMode: 'full' }), 'a@b.com', '', '2026-10-05', '');
  assert.equal(named.name, '김태민');
  assert.equal(named.actualName, '김태민');

  // 공개에 동의하지 않으면 목록에 아예 나오지 않습니다.
  assert.equal(await H.buildProfileFromDraft(H.cleanProfileDraft({ ...baseDraft, consent: false }), 'a@b.com', '', '2026-10-05', ''), null);

  // 저장한 값을 다시 불러오면 그대로 돌아옵니다.
  const roundTrip = H.profileDraftFromOverride({
    email: 'a@b.com', name: '김태민', generation: 2, display_mode: 'full',
    public_fields: ['gen', 'bio', 'unknown_field'], company: '', work: '', activity: '',
    region: '', instagram: '', bio: '소개', connect: '',
    allow_email_contact: false, attendee_visible: false, consent: true,
  });
  assert.deepEqual(roundTrip.publicFields, ['gen', 'bio']);
  assert.equal(roundTrip.attendeeVisible, false);

  // ---- 업장 입력 ----------------------------------------------------------
  assert.equal(H.cleanPlaceInput({ name: '' }).error, 'name_required');
  assert.equal(H.cleanPlaceInput({ name: '가게', website_url: 'javascript:alert(1)' }).error, 'invalid_link');
  assert.equal(H.cleanPlaceInput({ name: '가게', booking_url: 'ftp://a.example.com' }).error, 'invalid_link');
  const place = H.cleanPlaceInput({ name: ' 가게 ', category: '한식', website_url: 'https://a.example.com', description: '설명' }).value;
  assert.equal(place.name, '가게');
  assert.equal(place.website_url, 'https://a.example.com');
  assert.equal(place.region, null, '빈 값은 null 로 저장해야 합니다');
  assert.equal(H.safeLink(''), '');
  assert.equal(H.safeLink('data:text/html,x'), null);

  // ---- 졸업생 DB 이름: 초기 응답자는 이름 칸에 "이름/기수/연락처"를 함께 적었습니다 ----
  assert.equal(H.alumniName('강민성/8기/010-0000-0000'), '강민성');
  assert.equal(H.alumniName(" 김윤곤 / '010"), '김윤곤');
  assert.equal(H.alumniName('김호영'), '김호영');
  assert.equal(H.alumniName('Jenny Kim'), 'Jenny Kim');
  assert.equal(H.alumniName(''), '');

  // ---- 번개·소모임 입력 ----------------------------------------------------
  const NOW = Date.parse('2026-10-06T00:00:00Z');
  const meetup = { title: ' 서울 와인 모임 ', category: 'food', startsAt: '2026-10-25T10:00:00Z', capacity: '6', region: '서울', place: '성수', description: '편하게 와요' };
  const okMeetup = H.cleanMeetupInput(meetup, NOW).value;
  assert.equal(okMeetup.title, '서울 와인 모임');
  assert.equal(okMeetup.capacity, 6);
  assert.equal(okMeetup.starts_at, '2026-10-25T10:00:00.000Z');
  assert.equal(H.cleanMeetupInput({ ...meetup, capacity: '' }, NOW).value.capacity, null, '정원은 비워둘 수 있습니다');
  assert.equal(H.cleanMeetupInput({ ...meetup, title: ' ' }, NOW).error, 'title_required');
  assert.equal(H.cleanMeetupInput({ ...meetup, category: 'party' }, NOW).error, 'invalid_category');
  assert.equal(H.cleanMeetupInput({ ...meetup, startsAt: 'nope' }, NOW).error, 'invalid_date');
  assert.equal(H.cleanMeetupInput({ ...meetup, startsAt: '2026-10-01T10:00:00Z' }, NOW).error, 'date_in_past');
  assert.equal(H.cleanMeetupInput({ ...meetup, startsAt: '2028-01-01T10:00:00Z' }, NOW).error, 'date_too_far');
  assert.equal(H.cleanMeetupInput({ ...meetup, capacity: 1 }, NOW).error, 'invalid_capacity');
  assert.equal(H.cleanMeetupInput({ ...meetup, capacity: 2.5 }, NOW).error, 'invalid_capacity');
  assert.equal(H.cleanMeetupInput({ ...meetup, capacity: 201 }, NOW).error, 'invalid_capacity');
  assert.equal(H.cleanMeetupInput({ ...meetup, region: '' }, NOW).value.region, null);

  // ---- 도와줄 수 있는 분야 · 질문 · 자료실 입력 ----------------------------------
  assert.deepEqual(H.cleanHelpTopics(['창업 준비', '아무거나', '메뉴 개발']), ['창업 준비', '메뉴 개발'], '모르는 분야는 버립니다');
  assert.deepEqual(H.cleanHelpTopics('창업 준비'), []);
  assert.deepEqual(H.cleanProfileDraft({ ...baseDraft, helpTopics: ['해외 취업·유학', 'x'] }).helpTopics, ['해외 취업·유학']);
  assert.deepEqual(H.profileDraftFromOverride({ name: 'a', consent: false }).helpTopics, [], '예전 행에는 분야가 없을 수 있습니다');
  const helper = await H.buildProfileFromDraft(H.cleanProfileDraft({ ...baseDraft, helpTopics: ['창업 준비'] }), 'a@b.com', '', '2026-10-05', '');
  assert.deepEqual(helper.helpTopics, ['창업 준비']);
  assert.equal(await H.buildProfileFromDraft(H.cleanProfileDraft({ ...baseDraft, helpTopics: ['창업 준비'], consent: false }), 'a@b.com', '', '2026-10-05', ''), null, '비공개 프로필의 분야는 나가지 않습니다');
  assert.deepEqual(H.boardTopic('question', '창업 준비'), { topic: '창업 준비' });
  assert.equal(H.boardTopic('question', '없는 분야').error, 'invalid_topic', '질문 글은 분야가 있어야 합니다');
  assert.deepEqual(H.boardTopic('free', '창업 준비'), { topic: null }, '질문이 아닌 글에는 분야를 붙이지 않습니다');
  assert.equal(H.resourceExtension('원가계산표.XLSX'), 'xlsx');
  assert.equal(H.resourceExtension('오픈체크리스트.hwp'), 'hwp');
  assert.equal(H.resourceExtension('virus.exe'), '');
  assert.equal(H.resourceExtension('noext'), '');
  assert.equal(H.cleanResourceInput({ title: '원가표', category: 'cost', filePath: 'u/1.xlsx' }).value.link_url, null);
  assert.equal(H.cleanResourceInput({ title: '원가표', category: 'cost', linkUrl: 'https://drive.google.com/x' }).value.link_url, 'https://drive.google.com/x');
  assert.equal(H.cleanResourceInput({ title: '원가표', category: 'cost' }).error, 'file_or_link_required');
  assert.equal(H.cleanResourceInput({ title: '원가표', category: 'cost', linkUrl: 'javascript:alert(1)' }).error, 'invalid_link');
  assert.equal(H.cleanResourceInput({ title: '원가표', category: 'nope', linkUrl: 'https://a.b' }).error, 'invalid_category');
  assert.equal(H.cleanResourceInput({ title: ' ', category: 'cost', linkUrl: 'https://a.b' }).error, 'title_required');

  // ---- 도우미 분야(폼 연결 희망 분야 포함) · 태그 ------------------------------
  assert.deepEqual(H.helpTopicsFor(['매장 운영'], '정보 교류, 창업, 메뉴개발 / R&D'), ['창업 준비', '매장 운영', '메뉴 개발']);
  assert.deepEqual(H.helpTopicsFor([], ''), [], '연결 희망 분야를 공개하지 않았으면 도우미로 나오지 않습니다');
  assert.deepEqual(H.helpTopicsFor([], '멘토링 / 후배 지원, 특별히 없음'), []);
  const id = 'a'.repeat(24);
  assert.deepEqual(H.cleanMentions([id, id, 'x', 'B'.repeat(24)]), [id], '중복·잘못된 id는 버립니다');
  assert.equal(H.cleanMentions(Array.from({ length: 15 }, (_, i) => i.toString(16).padStart(24, '0'))).length, 10, '한 번에 10명까지');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: 프로필 입력 검증, 공개 범위(마스킹/비공개/실명), 동의 없으면 비공개, 저장·복원, 업장 입력과 링크 검증, 졸업생 DB 이름 추출, 소모임 입력 검증, 도움 분야·질문 분야·자료실 입력 검증, 도우미 분야·태그');
})().catch((e) => { console.error(e); process.exit(1); });
