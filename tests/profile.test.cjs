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
fs.writeFileSync(file, body + '\nexport { cleanProfileDraft, cleanPlaceInput, safeLink, buildProfileFromDraft, profileDraftFromOverride, maskName };\n');

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

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: 프로필 입력 검증, 공개 범위(마스킹/비공개/실명), 동의 없으면 비공개, 저장·복원, 업장 입력과 링크 검증');
})().catch((e) => { console.error(e); process.exit(1); });
