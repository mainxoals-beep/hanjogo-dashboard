import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.117.0";

const ALUMNI_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSuW1LbjftAqI7V9V65eehlY_KQ4JIRwLR80rfUdAQXoFGywIOs4tk1LAuRBJ17pEdAslBjpLaqqCY5/pub?output=csv";
const PROFILE_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQm2qyYr9BAEm-fyZvNyExxiPS9lcRBPi06n__Qq__WlRPvGF_Iou7x1lIjsmBgqpoqHo4M2syaFVxc/pub?gid=648141668&single=true&output=csv";
const ADMIN_EMAIL = "mainxoals@gmail.com";
const ALUMNI_EMAIL_CACHE_TTL = 5 * 60 * 1000;
let alumniEmailCache: { expiresAt: number; emails: Set<string> } | null = null;
let alumniEmailCachePromise: Promise<Set<string>> | null = null;
// 태그·도우미 목록에 쓰는 공개 프로필 목록. 몇 분 동안 다시 쓰고, 프로필을 저장하면 비웁니다.
let publicPeopleCache: { expiresAt: number; people: PublicPerson[] } | null = null;
type PublicPerson = { profileId: string; email: string; name: string; generation: number | null; topics: string[] };
// 생일: 졸업생 DB(없으면 프로필 폼)의 생년월일 칸에서 월·일("MM-DD")만 뽑아 잠깐 기억합니다. 연도는 버립니다.
type BirthdayIndex = { days: Map<string, string>; column: string; total: number; parsed: number };
let birthdayCache: { expiresAt: number; index: BirthdayIndex } | null = null;

const cors = {
  "Access-Control-Allow-Origin": "https://mainxoals-beep.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const securityHeaders = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeKey(value: unknown) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (ch !== "\r") cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

async function fetchCsv(url: string) {
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) throw new Error("csv_unavailable");
  return parseCsv(await res.text());
}

function rowsAsObjects(rows: string[][]) {
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => String(value || "").trim());
  return rows.slice(1).filter((row) => row.some((value) => String(value || "").trim())).map((row) => {
    const result: Record<string, string> = {};
    headers.forEach((header, index) => { result[header] = String(row[index] ?? "").trim(); });
    return result;
  });
}

function latestProfileRowsByEmail(rows: Record<string, string>[]) {
  const latest = new Map<string, Record<string, string>>();
  const withoutEmail: Record<string, string>[] = [];
  rows.forEach((row) => {
    const email = normalizeEmail(getField(row, "Email Address") || getField(row, "이메일"));
    if (!email) {
      withoutEmail.push(row);
      return;
    }
    latest.set(email, row);
  });
  return [...latest.values(), ...withoutEmail];
}

/** Resolve repeated submissions before applying the latest privacy choices.
 * Different emails are linked only with full name, cohort AND Instagram.
 * Never merge on a masked display name or name/cohort alone.
 */
function latestPublicProfileRows(rows: Record<string, string>[], firstDates: Map<string, string>) {
  const parents = rows.map((_, index) => index);
  function root(index: number): number {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  const identities = new Map<string, number>();
  rows.forEach((row, index) => {
    const email = normalizeEmail(getField(row, "Email Address") || getField(row, "이메일"));
    const name = normalizeKey(getField(row, "이름"));
    const generation = numberFromText(getField(row, "졸업 기수"));
    const instagram = safeInstagram(getField(row, "Instagram"));
    const keys = email ? ["email:" + email] : [];
    if (name && generation && instagram) {
      keys.push("identity:" + JSON.stringify([name, generation, instagram.url.toLowerCase()]));
    }
    keys.forEach((key) => {
      const previous = identities.get(key);
      if (previous !== undefined) parents[root(previous)] = root(index);
      identities.set(key, index);
    });
  });
  const groups = new Map<number, Record<string, string>[]>();
  rows.forEach((row, index) => {
    const id = root(index);
    const group = groups.get(id) || [];
    group.push(row);
    groups.set(id, group);
  });
  return [...groups.values()].map((group) => {
    const emails = group.map((row) => normalizeEmail(getField(row, "Email Address") || getField(row, "이메일")));
    const dates = emails.map((email) => firstDates.get(email)).filter((date): date is string => Boolean(date)).sort();
    if (dates.length) emails.filter(Boolean).forEach((email) => firstDates.set(email, dates[0]));
    // Google Forms appends responses in submission order.
    return group[group.length - 1];
  });
}

function profileDateKey(row: Record<string, string>) {
  const raw = String(getField(row, "Timestamp") || getField(row, "타임스탬프") || "").trim();
  if (!raw) return "";
  const yearFirst = raw.match(/^(\d{4})\s*(?:년|[.\/-])\s*(\d{1,2})\s*(?:월|[.\/-])\s*(\d{1,2})/);
  if (yearFirst) return `${yearFirst[1]}-${yearFirst[2].padStart(2, "0")}-${yearFirst[3].padStart(2, "0")}`;
  const monthFirst = raw.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (monthFirst) return `${monthFirst[3]}-${monthFirst[1].padStart(2, "0")}-${monthFirst[2].padStart(2, "0")}`;
  return "";
}

/** "1995-03-04", "1995. 3. 4", "3/4/1995", "950304", "3월 4일" 등에서 "03-04"만 돌려줍니다. */
function birthMonthDay(value: unknown) {
  const raw = String(value ?? "").trim();
  const groups = raw.match(/\d+/g) || [];
  let month = 0;
  let day = 0;
  if (groups.length === 1) {
    const g = groups[0];
    if (g.length === 8) { month = Number(g.slice(4, 6)); day = Number(g.slice(6, 8)); }
    else if (g.length === 6) { month = Number(g.slice(2, 4)); day = Number(g.slice(4, 6)); }
    else if (g.length === 4) { month = Number(g.slice(0, 2)); day = Number(g.slice(2, 4)); }
  } else if (groups.length === 2) {
    month = Number(groups[0]); day = Number(groups[1]);
  } else if (groups.length >= 3) {
    if (groups[2].length === 4 && groups[0].length <= 2) { month = Number(groups[0]); day = Number(groups[1]); }
    else { month = Number(groups[1]); day = Number(groups[2]); }
  }
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return "";
  return String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

/** 오늘(한국 시간) 생일로 칠 "MM-DD" 목록. 윤년이 아니면 2월 29일생은 2월 28일에 축하합니다. */
function birthdayKeysForToday(todayKey: string) {
  const md = todayKey.slice(5);
  const year = Number(todayKey.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return md === "02-28" && !leap ? new Set([md, "02-29"]) : new Set([md]);
}

async function birthdayIndex(): Promise<BirthdayIndex> {
  if (birthdayCache && birthdayCache.expiresAt > Date.now()) return birthdayCache.index;
  // 폼 질문 제목이 "생년 월일 예 : 20070928"처럼 띄어 쓰여 있어 공백을 빼고 찾습니다.
  const isBirthColumn = (key: string) => /생년월일|생일|birth/i.test(key.replace(/\s+/g, ""));
  let index: BirthdayIndex = { days: new Map(), column: "", total: 0, parsed: 0 };
  for (const source of [ALUMNI_CSV_URL, PROFILE_CSV_URL]) {
    const rows = rowsAsObjects(await fetchCsv(source));
    const column = rows.length ? Object.keys(rows[0]).find(isBirthColumn) || "" : "";
    if (!column) continue;
    const emailKey = Object.keys(rows[0]).find((key) => /이메일|email/i.test(key)) || "";
    const days = new Map<string, string>();
    let total = 0;
    rows.forEach((row) => {
      const rowEmail = normalizeEmail(emailKey ? row[emailKey] : "");
      if (!rowEmail || !String(row[column] || "").trim()) return;
      total += 1;
      const md = birthMonthDay(row[column]);
      if (md) days.set(rowEmail, md);
    });
    index = { days, column, total, parsed: days.size };
    break;
  }
  birthdayCache = { expiresAt: Date.now() + 10 * 60 * 1000, index };
  return index;
}

function koreaDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function firstPublicProfileDates(rows: Record<string, string>[]) {
  const dates = new Map<string, string>();
  rows.forEach((row) => {
    const email = normalizeEmail(getField(row, "Email Address") || getField(row, "이메일"));
    const consent = getField(row, "작성하신 정보 중 일부를 한조고 네트워크 사이트에 공개하는 것에 동의하시나요?");
    const dateKey = profileDateKey(row);
    const current = dates.get(email);
    if (email && consent.includes("동의합니다") && dateKey && (!current || dateKey < current)) {
      dates.set(email, dateKey);
    }
  });
  return dates;
}

function dateKeyWithinDays(dateKey: string, todayKey: string, days: number) {
  const date = Date.parse(dateKey + "T00:00:00Z");
  const today = Date.parse(todayKey + "T00:00:00Z");
  if (!Number.isFinite(date) || !Number.isFinite(today)) return false;
  const difference = Math.floor((today - date) / 86400000);
  return difference >= 0 && difference < days;
}

async function stableProfileId(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getField(row: Record<string, string>, label: string) {
  const key = Object.keys(row).find((candidate) => normalizeKey(candidate) === normalizeKey(label));
  return key ? row[key] : "";
}

async function alumniEmailExists(email: string) {
  if (alumniEmailCache && alumniEmailCache.expiresAt > Date.now()) return alumniEmailCache.emails.has(email);
  if (!alumniEmailCachePromise) {
    alumniEmailCachePromise = (async () => {
      const rows = await fetchCsv(ALUMNI_CSV_URL);
      if (!rows.length) return new Set<string>();
      const headers = rows[0].map((value) => value.trim().toLowerCase());
      const emailIndex = headers.findIndex((header) => header.includes("이메일") || header === "email" || header.includes("email address"));
      if (emailIndex < 0) throw new Error("alumni_email_column_missing");
      return new Set(rows.slice(1).map((row) => normalizeEmail(row[emailIndex])).filter(Boolean));
    })();
  }
  try {
    const emails = await alumniEmailCachePromise;
    alumniEmailCache = { emails, expiresAt: Date.now() + ALUMNI_EMAIL_CACHE_TTL };
    return emails.has(email);
  } finally {
    alumniEmailCachePromise = null;
  }
}

function maskName(name: string) {
  const value = String(name || "").trim();
  if (!value) return "이름 비공개";
  if (value.length === 1) return "○";
  if (value.length === 2) return value[0] + "○";
  return value[0] + "○".repeat(Math.max(1, value.length - 2)) + value[value.length - 1];
}

function fieldSet(row: Record<string, string>) {
  return new Set(getField(row, "사이트에 공개해도 되는 정보를 모두 선택해주세요").split(",").map((value) => value.trim()).filter(Boolean));
}

function isAllowed(fields: Set<string>, label: string) {
  return [...fields].some((value) => normalizeKey(value) === normalizeKey(label));
}

function safeInstagram(value: string) {
  const raw = String(value || "").trim();
  if (!raw || /^(없음|없어요|없습니다|해당\s*없음|-|x)$/i.test(raw)) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return null;
  if (/^https?:\/\/([\w-]+\.)?instagram\.com\//i.test(raw)) {
    const url = raw.replace(/^http:\/\//i, "https://");
    return { label: url.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "@").replace(/\/$/, ""), url };
  }
  const handle = raw.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]+$/.test(handle)) return null;
  return { label: "@" + handle, url: "https://www.instagram.com/" + handle + "/" };
}

function cleanNarrative(value: string) {
  const text = String(value || "").trim();
  if (!text || /^(없음|없어요|없습니다|해당\s*없음|현재\s*프로젝트|사업체\s*[-·/]?\s*브랜드(?:\s*소개)?|x|-)\.?$/i.test(text)) return "";
  return text;
}

function cleanBoardText(value: unknown, maxLength: number) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

/** The person's name from the alumni directory's 이름 answer. Early respondents
 * (before the form was split into separate questions) typed "이름/기수/연락처"
 * into this one box, so keep only the leading Korean name when there is one. */
function alumniName(value: unknown) {
  const text = String(value ?? "").trim();
  const korean = text.match(/^([가-힣]{2,5})(?![가-힣])/);
  return korean ? korean[1] : text;
}

function numberFromText(value: unknown) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

async function boardIdentity(
  email: string,
  special: Record<string, unknown> | null,
  override?: Record<string, unknown> | null,
) {
  if (email === ADMIN_EMAIL) return { name: "김태민", generation: 2 };
  // A profile edited on the site is the person's own latest answer.
  if (override) {
    const name = cleanBoardText(override.name, 40);
    if (name) return { name, generation: override.generation == null ? null : Number(override.generation) };
  }
  try {
    const rows = latestProfileRowsByEmail(rowsAsObjects(await fetchCsv(PROFILE_CSV_URL)));
    const row = rows.find((item) => normalizeEmail(getField(item, "Email Address") || getField(item, "이메일")) === email);
    if (row) {
      const name = cleanBoardText(getField(row, "이름"), 40);
      const generation = numberFromText(getField(row, "졸업 기수"));
      if (name) return { name, generation };
    }
  } catch {}
  try {
    const rows = rowsAsObjects(await fetchCsv(ALUMNI_CSV_URL));
    const row = rows.find((item) => {
      const emailKey = Object.keys(item).find((key) => /이메일|email/i.test(key));
      return emailKey ? normalizeEmail(item[emailKey]) === email : false;
    });
    if (row) {
      const nameKey = Object.keys(row).find((key) => /(^|\s)이름(\s|$)|성명/.test(key));
      const genKey = Object.keys(row).find((key) => /기수/.test(key));
      const name = cleanBoardText(alumniName(nameKey ? row[nameKey] : ""), 40);
      const generation = numberFromText(genKey ? row[genKey] : "");
      if (name) return { name, generation };
    }
  } catch {}
  const specialName = cleanBoardText(special?.name, 40);
  return { name: specialName || email.split("@")[0], generation: null };
}

// "generation"(우리 기수)은 같은 기수 동문만 보고 쓸 수 있습니다.
const BOARD_CATEGORIES = ["free", "jobs", "collab", "business", "notice", "question", "resource", "generation"];

/**
 * A "question" post names one of the help fields; a "resource"(자료 공유) post names a
 * resource kind (원가·발주 …). Other posts carry none.
 */
function boardTopic(category: string, value: unknown) {
  const topic = String(value ?? "");
  if (category === "question") return HELP_TOPICS.includes(topic) ? { topic } : { error: "invalid_topic" };
  if (category === "resource") return RESOURCE_CATEGORIES.includes(topic) ? { topic } : { error: "invalid_topic" };
  return { topic: null };
}

function publicBoardPost(
  row: Record<string, unknown>,
  comments: Record<string, unknown>[],
  reactions: Record<string, unknown>[],
  viewCount: number,
  userId: string,
  isAdmin: boolean,
) {
  const reactionCounts = { like: 0, heart: 0, clap: 0, useful: 0 };
  reactions.forEach((item) => {
    const key = String(item.reaction || "") as keyof typeof reactionCounts;
    if (key in reactionCounts) reactionCounts[key] += 1;
  });
  return {
    id: row.id, category: row.category, title: row.title, content: row.content,
    topic: row.topic ?? null, isResolved: Boolean(row.is_resolved),
    // 자료 공유 글의 첨부. 저장 경로는 내보내지 않고, 받을 때 board_download 로 짧게 쓰는 주소를 만듭니다.
    hasFile: Boolean(row.file_path), fileName: row.file_name ?? null, fileSize: row.file_size ?? null,
    linkUrl: row.link_url ?? null, downloadCount: Number(row.download_count || 0),
    authorName: row.author_name, authorGeneration: row.author_generation,
    targetGeneration: row.target_generation ?? null,
    isNotice: Boolean(row.is_notice), createdAt: row.created_at, updatedAt: row.updated_at,
    canEdit: isAdmin || row.author_id === userId,
    viewCount,
    reactionCounts,
    ownReactions: reactions.filter((item) => item.user_id === userId).map((item) => item.reaction),
    comments: comments.map((comment) => ({
      id: comment.id, content: comment.content, authorName: comment.author_name,
      authorGeneration: comment.author_generation, createdAt: comment.created_at,
      canDelete: isAdmin || comment.author_id === userId,
    })),
  };
}

async function buildProfile(
  row: Record<string, string>,
  contactOverrides: Map<string, boolean>,
  firstPublicDates: Map<string, string>,
  todayKey: string,
  viewerEmail: string,
) {
  const consent = getField(row, "작성하신 정보 중 일부를 한조고 네트워크 사이트에 공개하는 것에 동의하시나요?");
  if (!consent.includes("동의합니다")) return null;
  const fields = fieldSet(row);
  const displayMode = getField(row, "사이트에서 이름을 어떻게 표시할까요?");
  const actualName = getField(row, "이름");
  const fullNamePublic = displayMode.includes("실명 전체");
  const name = fullNamePublic ? actualName : displayMode.includes("마스킹") ? maskName(actualName) : "이름 비공개";
  const generation = getField(row, "졸업 기수");
  const email = getField(row, "Email Address");
  const contactConsent = getField(row, "동문들이 한조고 네트워크를 통해 이메일로 직접 연락할 수 있도록 허용하시겠습니까?");
  const normalizedEmail = normalizeEmail(email);
  const formAllowsEmailContact = contactConsent.includes("허용합니다");
  const allowEmailContact = contactOverrides.has(normalizedEmail)
    ? Boolean(contactOverrides.get(normalizedEmail))
    : formAllowsEmailContact;
  const attendeePreference = getField(row, "행사 참가자 명단에 표시해도 될까요?");
  const firstPublicDate = firstPublicDates.get(normalizedEmail) || "";
  const profileId = await stableProfileId(normalizedEmail || `${generation}|${actualName}|${profileDateKey(row)}`);
  return {
    name,
    actualName: fullNamePublic ? actualName : "",
    fullNamePublic,
    gen: isAllowed(fields, "졸업 기수") ? generation : "",
    company: isAllowed(fields, "현재 소속 / 직장 / 사업체·브랜드") ? getField(row, "현재 소속 / 직장 / 사업체·브랜드") : "",
    work: isAllowed(fields, "현재 하는 일") ? getField(row, "현재 하는 일") : "",
    activity: isAllowed(fields, "활동 분야") ? getField(row, "활동 분야") : "",
    region: isAllowed(fields, "활동 지역") ? getField(row, "활동 지역") : "",
    instagram: isAllowed(fields, "Instagram") ? safeInstagram(getField(row, "Instagram")) : null,
    bio: isAllowed(fields, "프로필 소개") ? cleanNarrative(getField(row, "동문들에게 소개하고 싶은 내용")) : "",
    connect: isAllowed(fields, "연결 희망 분야") ? getField(row, "동문들과 어떤 분야로 연결되고 싶나요?") : "",
    email: allowEmailContact ? email : "",
    allowEmailContact,
    attendeeVisible: !attendeePreference.includes("표시하지"),
    attendeeMaskedName: maskName(actualName),
    profileId,
    isOwnProfile: Boolean(normalizedEmail) && normalizedEmail === viewerEmail,
    isNew: Boolean(firstPublicDate) && firstPublicDate === todayKey,
    isRecent: dateKeyWithinDays(firstPublicDate, todayKey, 7),
    // 기수를 공개하지 않은 사람은 정렬값으로도 기수가 드러나지 않게 합니다.
    sortGen: isAllowed(fields, "졸업 기수") ? Number(generation) || 999 : 999,
    sortName: name,
  };
}

/** Fields an alumnus can choose to publish. Stored as short keys in
 * hanjogo_profile_overrides.public_fields; the form CSV uses Korean labels. */
const PROFILE_FIELD_KEYS = ["gen", "company", "work", "activity", "region", "instagram", "bio", "connect"] as const;
type ProfileFieldKey = typeof PROFILE_FIELD_KEYS[number];
const PROFILE_FIELD_LABELS: Record<ProfileFieldKey, string> = {
  gen: "졸업 기수",
  company: "현재 소속 / 직장 / 사업체·브랜드",
  work: "현재 하는 일",
  activity: "활동 분야",
  region: "활동 지역",
  instagram: "Instagram",
  bio: "프로필 소개",
  connect: "연결 희망 분야",
};
const PROFILE_TEXT_LIMITS: Record<string, number> = {
  name: 40, company: 120, work: 120, activity: 120,
  region: 60, instagram: 200, bio: 1000, connect: 300,
};

function dateKeyFromTimestamp(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
}

/** The editable values behind a profile, read from the form CSV row.
 * Used to pre-fill the in-page editor the first time someone opens it. */
function profileDraftFromCsv(row: Record<string, string>) {
  const fields = fieldSet(row);
  const displayMode = getField(row, "사이트에서 이름을 어떻게 표시할까요?");
  const consent = getField(row, "작성하신 정보 중 일부를 한조고 네트워크 사이트에 공개하는 것에 동의하시나요?");
  const contactConsent = getField(row, "동문들이 한조고 네트워크를 통해 이메일로 직접 연락할 수 있도록 허용하시겠습니까?");
  const attendeePreference = getField(row, "행사 참가자 명단에 표시해도 될까요?");
  return {
    name: getField(row, "이름"),
    generation: numberFromText(getField(row, "졸업 기수")),
    displayMode: displayMode.includes("실명 전체") ? "full" : displayMode.includes("마스킹") ? "masked" : "hidden",
    publicFields: PROFILE_FIELD_KEYS.filter((key) => isAllowed(fields, PROFILE_FIELD_LABELS[key])),
    company: getField(row, "현재 소속 / 직장 / 사업체·브랜드"),
    work: getField(row, "현재 하는 일"),
    activity: getField(row, "활동 분야"),
    region: getField(row, "활동 지역"),
    instagram: getField(row, "Instagram"),
    bio: cleanNarrative(getField(row, "동문들에게 소개하고 싶은 내용")),
    connect: getField(row, "동문들과 어떤 분야로 연결되고 싶나요?"),
    allowEmailContact: contactConsent.includes("허용합니다"),
    attendeeVisible: !attendeePreference.includes("표시하지"),
    consent: consent.includes("동의합니다"),
    helpTopics: [] as string[],
  };
}

function profileDraftFromOverride(row: Record<string, unknown>) {
  return {
    name: String(row.name ?? ""),
    generation: row.generation == null ? null : Number(row.generation),
    displayMode: String(row.display_mode ?? "masked"),
    publicFields: ((row.public_fields as string[] | null) ?? []).filter(
      (key): key is ProfileFieldKey => (PROFILE_FIELD_KEYS as readonly string[]).includes(key),
    ),
    company: String(row.company ?? ""),
    work: String(row.work ?? ""),
    activity: String(row.activity ?? ""),
    region: String(row.region ?? ""),
    instagram: String(row.instagram ?? ""),
    bio: String(row.bio ?? ""),
    connect: String(row.connect ?? ""),
    allowEmailContact: Boolean(row.allow_email_contact),
    attendeeVisible: Boolean(row.attendee_visible),
    consent: Boolean(row.consent),
    helpTopics: cleanHelpTopics(row.help_topics),
  };
}

type ProfileDraft = ReturnType<typeof profileDraftFromOverride>;

/** Same shape as buildProfile(), but from a draft the alumnus saved in-page. */
async function buildProfileFromDraft(
  draft: ProfileDraft,
  email: string,
  firstPublicDate: string,
  todayKey: string,
  viewerEmail: string,
) {
  if (!draft.consent) return null;
  const actualName = String(draft.name || "").trim();
  const fullNamePublic = draft.displayMode === "full";
  const name = fullNamePublic ? actualName : draft.displayMode === "masked" ? maskName(actualName) : "이름 비공개";
  const shows = (key: ProfileFieldKey) => draft.publicFields.includes(key);
  const generation = draft.generation == null ? "" : String(draft.generation);
  return {
    name,
    actualName: fullNamePublic ? actualName : "",
    fullNamePublic,
    gen: shows("gen") ? generation : "",
    company: shows("company") ? draft.company : "",
    work: shows("work") ? draft.work : "",
    activity: shows("activity") ? draft.activity : "",
    region: shows("region") ? draft.region : "",
    instagram: shows("instagram") ? safeInstagram(draft.instagram) : null,
    bio: shows("bio") ? cleanNarrative(draft.bio) : "",
    connect: shows("connect") ? draft.connect : "",
    email: draft.allowEmailContact ? email : "",
    allowEmailContact: draft.allowEmailContact,
    attendeeVisible: draft.attendeeVisible,
    attendeeMaskedName: maskName(actualName),
    // 도와줄 수 있는 분야는 그 목적(공개)으로 고르는 항목입니다. 프로필 공개에 동의한 경우에만 여기까지 옵니다.
    helpTopics: draft.helpTopics,
    profileId: await stableProfileId(email),
    isOwnProfile: Boolean(email) && email === viewerEmail,
    isNew: Boolean(firstPublicDate) && firstPublicDate === todayKey,
    isRecent: dateKeyWithinDays(firstPublicDate, todayKey, 7),
    sortGen: shows("gen") ? Number(generation) || 999 : 999,
    sortName: name,
  };
}

/** Validate what the browser sent before it becomes someone's public profile. */
function cleanProfileDraft(body: Record<string, unknown>): ProfileDraft | { error: string } {
  const text = (value: unknown, key: string) => cleanBoardText(value, PROFILE_TEXT_LIMITS[key] ?? 120);
  const name = text(body.name, "name");
  const displayMode = String(body.displayMode ?? "masked");
  const consent = Boolean(body.consent);
  if (!["full", "masked", "hidden"].includes(displayMode)) return { error: "invalid_display_mode" };
  if (consent && !name) return { error: "name_required" };
  let generation: number | null = null;
  if (body.generation !== null && body.generation !== undefined && String(body.generation).trim() !== "") {
    const parsed = numberFromText(body.generation);
    if (parsed === null || parsed < 1 || parsed > 99) return { error: "invalid_generation" };
    generation = parsed;
  }
  const requested = Array.isArray(body.publicFields) ? body.publicFields.map((value) => String(value)) : [];
  const publicFields = PROFILE_FIELD_KEYS.filter((key) => requested.includes(key));
  const instagram = text(body.instagram, "instagram");
  if (instagram && !safeInstagram(instagram)) return { error: "invalid_instagram" };
  return {
    name,
    generation,
    displayMode,
    publicFields,
    company: text(body.company, "company"),
    work: text(body.work, "work"),
    activity: text(body.activity, "activity"),
    region: text(body.region, "region"),
    instagram,
    bio: text(body.bio, "bio"),
    connect: text(body.connect, "connect"),
    allowEmailContact: Boolean(body.allowEmailContact),
    attendeeVisible: Boolean(body.attendeeVisible),
    consent,
    helpTopics: cleanHelpTopics(body.helpTopics),
  };
}

function draftToOverrideRow(draft: ProfileDraft, email: string) {
  return {
    email,
    name: draft.name,
    generation: draft.generation,
    display_mode: draft.displayMode,
    public_fields: draft.publicFields,
    company: draft.company,
    work: draft.work,
    activity: draft.activity,
    region: draft.region,
    instagram: draft.instagram,
    bio: draft.bio,
    connect: draft.connect,
    allow_email_contact: draft.allowEmailContact,
    attendee_visible: draft.attendeeVisible,
    consent: draft.consent,
    help_topics: draft.helpTopics,
    updated_at: new Date().toISOString(),
  };
}

const PLACE_TEXT_LIMITS: Record<string, number> = {
  name: 80, category: 40, region: 40, address: 200,
  instagram_url: 300, website_url: 300, booking_url: 300, description: 600,
};

function safeLink(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    new URL(raw);
    return raw;
  } catch {
    return null;
  }
}

function cleanPlaceInput(body: Record<string, unknown>) {
  const field = (key: string) => cleanBoardText(body[key], PLACE_TEXT_LIMITS[key] ?? 120);
  const name = field("name");
  if (!name) return { error: "name_required" } as const;
  const links: Record<string, string> = {};
  for (const key of ["instagram_url", "website_url", "booking_url"]) {
    const value = safeLink(field(key));
    if (value === null) return { error: "invalid_link" } as const;
    links[key] = value;
  }
  return {
    value: {
      name,
      category: field("category") || null,
      region: field("region") || null,
      address: field("address") || null,
      instagram_url: links.instagram_url || null,
      website_url: links.website_url || null,
      booking_url: links.booking_url || null,
      description: field("description") || null,
    },
  } as const;
}

const MEETUP_CATEGORIES = ["food", "tour", "hobby", "work", "etc"];

/** Validate a meetup the browser sent. `now` is passed in so tests can pin it. */
function cleanMeetupInput(body: Record<string, unknown>, now = Date.now()) {
  const title = cleanBoardText(body.title, 80);
  if (!title) return { error: "title_required" } as const;
  const category = String(body.category ?? "");
  if (!MEETUP_CATEGORIES.includes(category)) return { error: "invalid_category" } as const;
  const startsAt = new Date(String(body.startsAt ?? ""));
  if (Number.isNaN(startsAt.getTime())) return { error: "invalid_date" } as const;
  if (startsAt.getTime() < now) return { error: "date_in_past" } as const;
  if (startsAt.getTime() > now + 366 * 86400000) return { error: "date_too_far" } as const;
  let capacity: number | null = null;
  if (body.capacity !== null && body.capacity !== undefined && String(body.capacity).trim() !== "") {
    const parsed = Number(body.capacity);
    if (!Number.isInteger(parsed) || parsed < 2 || parsed > 200) return { error: "invalid_capacity" } as const;
    capacity = parsed;
  }
  return {
    value: {
      title,
      category,
      starts_at: startsAt.toISOString(),
      region: cleanBoardText(body.region, 40) || null,
      place: cleanBoardText(body.place, 120) || null,
      capacity,
      description: cleanBoardText(body.description, 1500) || null,
    },
  } as const;
}

/** Fields an alumnus can offer help in. A board post in the "question" category picks one of these. */
const HELP_TOPICS = [
  "창업 준비", "매장 운영", "메뉴 개발", "제과·제빵 진로", "해외 취업·유학",
  "취업·이직", "식자재·유통", "마케팅·SNS", "교육·강의", "호텔·파인다이닝",
];

/** Google Form "연결 희망 분야" answers that clearly mean the same as a help field. */
const CONNECT_TO_HELP: Record<string, string> = {
  "창업": "창업 준비",
  "메뉴개발 / R&D": "메뉴 개발",
  "해외 취업 / 유학": "해외 취업·유학",
  "식자재 / 유통": "식자재·유통",
  "교육 / 강의": "교육·강의",
};

/** Help fields for a public profile: the ones picked on the site, plus the
 * form's 연결 희망 분야 answers that map onto a field. `connect` is only
 * non-empty when the person made it public, so nothing private leaks here. */
function helpTopicsFor(picked: unknown, connect: unknown) {
  const topics = new Set(cleanHelpTopics(picked));
  String(connect ?? "").split(/[,;\n]+/).map((tag) => tag.trim()).forEach((tag) => {
    if (CONNECT_TO_HELP[tag]) topics.add(CONNECT_TO_HELP[tag]);
  });
  return HELP_TOPICS.filter((topic) => topics.has(topic));
}

function validGeneration(value: unknown) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
}

/** Profile ids someone was @-tagged with: unique, at most 10. */
function cleanMentions(value: unknown) {
  const ids = Array.isArray(value) ? value.map((item) => String(item)) : [];
  return [...new Set(ids.filter((id) => /^[0-9a-f]{24}$/.test(id)))].slice(0, 10);
}

function cleanHelpTopics(value: unknown) {
  const requested = Array.isArray(value) ? value.map((item) => String(item)) : [];
  return HELP_TOPICS.filter((topic) => requested.includes(topic));
}

const RESOURCE_CATEGORIES = ["cost", "order", "store", "career", "hygiene", "etc"];
// HTML·ZIP도 받습니다. 내려받기 주소는 항상 첨부(download)로 만들어 브라우저가 화면에 띄우지 않고 저장합니다.
// 실행 파일(exe·apk·js 등)은 받지 않습니다.
const RESOURCE_EXTENSIONS = ["pdf", "xlsx", "xls", "csv", "docx", "doc", "pptx", "ppt", "hwp", "hwpx", "txt", "md", "json", "html", "htm", "zip", "png", "jpg", "jpeg", "gif", "webp"];
const RESOURCE_MAX_BYTES = 10 * 1024 * 1024;

/** The extension of an uploaded file, or "" when it is not one we accept. */
function resourceExtension(fileName: unknown) {
  const match = String(fileName ?? "").toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return match && RESOURCE_EXTENSIONS.includes(match[1]) ? match[1] : "";
}

/**
 * The link of a "자료 공유" post. Other posts never carry a link or file.
 * Whether the post ends up with a file or a link is checked by the caller,
 * which also knows about a file already attached when editing.
 */
function boardAttachmentLink(category: string, body: Record<string, unknown>) {
  if (category !== "resource") return { link: null } as const;
  const link = safeLink(cleanBoardText(body.linkUrl, 500));
  if (link === null) return { error: "invalid_link" } as const;
  return { link: link || null } as const;
}

/** Alumni directory rows (name, cohort, email) for owner matching. */
async function alumniPeople() {
  const rows = rowsAsObjects(await fetchCsv(ALUMNI_CSV_URL));
  return rows.map((row) => {
    const nameKey = Object.keys(row).find((key) => /(^|\s)이름(\s|$)|성명/.test(key));
    const genKey = Object.keys(row).find((key) => /기수/.test(key));
    const emailKey = Object.keys(row).find((key) => /이메일|email/i.test(key));
    return {
      name: alumniName(nameKey ? row[nameKey] : ""),
      generation: numberFromText(genKey ? row[genKey] : ""),
      email: normalizeEmail(emailKey ? row[emailKey] : ""),
    };
  }).filter((person) => person.name && person.generation && person.email);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...cors, ...securityHeaders } });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const adminClient = createClient(url, serviceKey);

  const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(jwt);
  const email = normalizeEmail(claimsData?.claims?.email);
  const userId = String(claimsData?.claims?.sub || "");
  if (claimsError || !email || !userId) return json({ error: "unauthorized" }, 401);
  const isAdmin = email === ADMIN_EMAIL;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const action = String(body.action || "verify");

  let special: Record<string, unknown> | null = null;
  if (!isAdmin) {
    const { data, error: specialError } = await adminClient
      .from("hanjogo_special_access")
      .select("id,email,name,note")
      .eq("email", email)
      .maybeSingle();
    if (specialError) return json({ error: specialError.message }, 500);
    special = data;
  }

  let inAlumniDb = false;
  try {
    inAlumniDb = isAdmin || Boolean(special) || await alumniEmailExists(email);
  } catch {
    return json({ allowed: false, error: "access_check_unavailable" }, 503);
  }

  /** The caller's own profile row, if they have edited it on the site. */
  async function myOverride() {
    const { data, error } = await adminClient
      .from("hanjogo_profile_overrides").select("*").eq("email", email).maybeSingle();
    if (error) throw error;
    return data;
  }

  /** How the caller appears on meetups, questions and resources: their
   * profile's name display choice (실명 / 가운데 ○ / 비공개) is applied once, when
   * they post or join. Email is never shown. */
  async function displayIdentity() {
    return identityOf(email, special);
  }

  /** 다른 동문이 화면에 보이는 이름·기수. 그 사람이 정한 표시 방식을 그대로 따릅니다. */
  async function identityOf(who: string, whoSpecial: Record<string, unknown> | null) {
    const { data: override, error } = await adminClient
      .from("hanjogo_profile_overrides").select("*").eq("email", who).maybeSingle();
    if (error) throw error;
    const identity = await boardIdentity(who, whoSpecial, override);
    let mode = "masked";
    if (who === ADMIN_EMAIL) mode = "full";
    else if (override) mode = String(override.display_mode || "masked");
    else {
      try {
        const row = latestProfileRowsByEmail(rowsAsObjects(await fetchCsv(PROFILE_CSV_URL)))
          .find((item) => normalizeEmail(getField(item, "Email Address") || getField(item, "이메일")) === who);
        const choice = row ? getField(row, "사이트에서 이름을 어떻게 표시할까요?") : "";
        if (choice.includes("실명 전체")) mode = "full";
        else if (choice && !choice.includes("마스킹")) mode = "hidden";
      } catch { /* 폼을 못 읽으면 가운데 ○ 로 표시합니다. */ }
    }
    const name = mode === "full" ? identity.name : mode === "hidden" ? "이름 비공개" : maskName(identity.name);
    const generation = Number(identity.generation);
    return {
      display_name: cleanBoardText(name, 40) || "동문",
      generation: Number.isInteger(generation) && generation >= 1 && generation <= 99 ? generation : null,
    };
  }

  /** 오늘 생일이고 생일 축하를 켠 동문들의 이메일(서버 안에서만 씁니다). */
  async function birthdayPeopleToday() {
    const { data, error } = await adminClient.from("hanjogo_birthday_optin").select("email");
    if (error) throw error;
    const index = await birthdayIndex();
    const keys = birthdayKeysForToday(koreaDateKey());
    return (data || []).map((row) => normalizeEmail(row.email))
      .filter((who) => keys.has(index.days.get(who) || ""));
  }

  /** Alumni who can be @-tagged or shown as helpers: public profiles only
   * (profile consent on, name not hidden), with the name as they chose to show
   * it. The email stays on the server; it is only used to deliver notifications. */
  async function publicPeople(): Promise<PublicPerson[]> {
    if (publicPeopleCache && publicPeopleCache.expiresAt > Date.now()) return publicPeopleCache.people;
    const { data: overrideRows, error } = await adminClient.from("hanjogo_profile_overrides").select("*");
    if (error) throw error;
    const overrides = new Map<string, Record<string, unknown>>(
      (overrideRows || []).map((row) => [normalizeEmail(row.email), row as Record<string, unknown>]),
    );
    const allRows = rowsAsObjects(await fetchCsv(PROFILE_CSV_URL));
    const todayKey = koreaDateKey();
    const firstDates = firstPublicProfileDates(allRows);
    const people: PublicPerson[] = [];
    const add = (profile: Record<string, unknown> | null, ownerEmail: string, picked: unknown) => {
      if (!profile || !ownerEmail || profile.name === "이름 비공개") return;
      people.push({
        profileId: String(profile.profileId),
        email: ownerEmail,
        name: String(profile.name),
        generation: numberFromText(profile.gen),
        topics: helpTopicsFor(picked, profile.connect),
      });
    };
    for (const row of latestPublicProfileRows(allRows, firstDates)) {
      const rowEmail = normalizeEmail(getField(row, "Email Address") || getField(row, "이메일"));
      if (!rowEmail || overrides.has(rowEmail)) continue;
      add(await buildProfile(row, new Map(), firstDates, todayKey, ""), rowEmail, []);
    }
    for (const [ownerEmail, row] of overrides) {
      const draft = profileDraftFromOverride(row);
      add(await buildProfileFromDraft(draft, ownerEmail, "", todayKey, ""), ownerEmail, draft.helpTopics);
    }
    people.sort((a, b) => (a.generation ?? 999) - (b.generation ?? 999) || a.name.localeCompare(b.name, "ko"));
    publicPeopleCache = { expiresAt: Date.now() + 3 * 60 * 1000, people };
    return people;
  }

  /** Leave an in-site notification (🔔) for each tagged person, never for yourself. */
  async function notifyMentions(mentionIds: string[], postId: number, title: string, actor: { name: string; generation: number | null }, skip: Set<string>) {
    if (!mentionIds.length) return;
    let people: PublicPerson[] = [];
    try { people = await publicPeople(); } catch { return; }
    const rows = people
      .filter((person) => mentionIds.includes(person.profileId) && person.email !== email && !skip.has(person.email))
      .map((person) => {
        skip.add(person.email);
        return { recipient_email: person.email, kind: "mention", post_id: postId, title: cleanBoardText(title, 120), actor_name: actor.name, actor_generation: validGeneration(actor.generation) };
      });
    if (rows.length) await adminClient.from("hanjogo_notifications").insert(rows);
  }

  if (action === "verify") {
    return json({ allowed: inAlumniDb, source: isAdmin ? "admin" : special ? "special" : inAlumniDb ? "alumni_db" : null, isAdmin });
  }

  if (action === "profiles") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    try {
      const { data: contactOverrideRows, error: contactOverrideError } = await adminClient
        .from("hanjogo_email_contact_consent")
        .select("email,allow_email_contact");
      if (contactOverrideError) throw contactOverrideError;
      const contactOverrides = new Map(
        (contactOverrideRows || []).map((row) => [normalizeEmail(row.email), Boolean(row.allow_email_contact)]),
      );
      const { data: overrideRows, error: overrideError } = await adminClient
        .from("hanjogo_profile_overrides")
        .select("*");
      if (overrideError) throw overrideError;
      const overrides = new Map<string, Record<string, unknown>>(
        (overrideRows || []).map((row) => [normalizeEmail(row.email), row as Record<string, unknown>]),
      );
      const allRows = rowsAsObjects(await fetchCsv(PROFILE_CSV_URL));
      const todayKey = koreaDateKey();
      const firstPublicDates = firstPublicProfileDates(allRows);
      const rows = latestPublicProfileRows(allRows, firstPublicDates);
      // A profile edited on the site replaces that person's form row.
      const fromCsv = await Promise.all(
        rows
          .filter((row) => !overrides.has(normalizeEmail(getField(row, "Email Address") || getField(row, "이메일"))))
          .map((row) => buildProfile(row, contactOverrides, firstPublicDates, todayKey, email)),
      );
      const fromSite = await Promise.all(
        [...overrides.values()].map((row) => {
          const ownerEmail = normalizeEmail(row.email);
          return buildProfileFromDraft(
            profileDraftFromOverride(row),
            ownerEmail,
            firstPublicDates.get(ownerEmail) || dateKeyFromTimestamp(row.created_at),
            todayKey,
            email,
          );
        }),
      );
      const profiles = [...fromCsv, ...fromSite].filter(Boolean) as Record<string, unknown>[];
      // 오늘의 동문: 이름을 공개(전체 또는 일부)했고 소개를 거부하지 않은 사람만 후보입니다.
      const { data: optOutRows, error: optOutError } = await adminClient.from("hanjogo_spotlight_optout").select("email");
      if (optOutError) throw optOutError;
      const optedOut = new Set(await Promise.all((optOutRows || []).map((row) => stableProfileId(normalizeEmail(row.email)))));
      profiles.forEach((profile) => {
        profile.spotlight = profile.name !== "이름 비공개" && !optedOut.has(String(profile.profileId));
      });
      return json({ allowed: true, profiles, count: profiles.length });
    } catch {
      return json({ allowed: true, error: "profiles_unavailable" }, 503);
    }
  }

  // ---- 내 정보: 본인 프로필 보기와 저장 ----------------------------------
  if (action === "spotlight_set") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const { error } = body.optOut
      ? await adminClient.from("hanjogo_spotlight_optout").upsert({ email }, { onConflict: "email", ignoreDuplicates: true })
      : await adminClient.from("hanjogo_spotlight_optout").delete().eq("email", email);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, spotlightOptOut: Boolean(body.optOut) });
  }

  // ---- 생일 축하 ------------------------------------------------------------
  // 본인이 켠 사람만, 생일 당일에만, 표시 이름·기수만 보여줍니다. 생년월일과 나이는 내보내지 않습니다.
  if (action === "birthday_set") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const on = Boolean(body.on);
    const { error } = on
      ? await adminClient.from("hanjogo_birthday_optin").upsert({ email }, { onConflict: "email", ignoreDuplicates: true })
      : await adminClient.from("hanjogo_birthday_optin").delete().eq("email", email);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, birthdayOptIn: on });
  }

  if (action === "birthday_today") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    try {
      const today = koreaDateKey();
      const emails = await birthdayPeopleToday();
      const { data: cheerRows, error: cheerError } = emails.length
        ? await adminClient.from("hanjogo_birthday_cheers").select("recipient_email,sender_email")
          .eq("cheer_date", today).in("recipient_email", emails)
        : { data: [], error: null };
      if (cheerError) throw cheerError;
      const people = await Promise.all(emails.filter((who) => who !== email).map(async (who) => {
        const identity = await identityOf(who, null);
        const mine = (cheerRows || []).filter((row) => row.recipient_email === who);
        return {
          id: await stableProfileId(who),
          name: identity.display_name,
          generation: identity.generation,
          cheers: mine.length,
          cheered: mine.some((row) => row.sender_email === email),
        };
      }));
      people.sort((a, b) => (a.generation ?? 999) - (b.generation ?? 999) || a.name.localeCompare(b.name, "ko"));
      const { data: optRow } = await adminClient.from("hanjogo_birthday_optin").select("email").eq("email", email).maybeSingle();
      const isBirthday = emails.includes(email);
      const result: Record<string, unknown> = {
        allowed: true,
        people,
        me: { optIn: Boolean(optRow), isBirthday, cheers: isBirthday ? (cheerRows || []).filter((row) => row.recipient_email === email).length : 0 },
      };
      if (isAdmin) {
        // 관리자 확인용: 어느 칸을 읽었고 몇 명의 날짜를 알아봤는지만 보여줍니다(값은 보내지 않음).
        const index = await birthdayIndex();
        result.check = { column: index.column, total: index.total, parsed: index.parsed };
      }
      return json(result);
    } catch {
      return json({ allowed: true, error: "birthday_unavailable" }, 503);
    }
  }

  if (action === "birthday_cheer") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const targetId = String(body.id || "");
    let target = "";
    try {
      for (const who of await birthdayPeopleToday()) {
        if (who !== email && await stableProfileId(who) === targetId) { target = who; break; }
      }
    } catch {
      return json({ error: "birthday_unavailable" }, 503);
    }
    if (!target) return json({ error: "not_birthday" }, 400);
    const { error } = await adminClient.from("hanjogo_birthday_cheers")
      .insert({ recipient_email: target, sender_email: email, cheer_date: koreaDateKey() });
    if (error && error.code !== "23505") return json({ error: error.message }, 500);
    if (!error) {
      const actor = await displayIdentity();
      await adminClient.from("hanjogo_notifications").insert({
        recipient_email: target, kind: "birthday", post_id: null, title: "생일 축하해요!",
        actor_name: actor.display_name, actor_generation: actor.generation,
      });
    }
    return json({ ok: true, already: Boolean(error) });
  }

  if (action === "profile_me") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const { data: optOutRow } = await adminClient.from("hanjogo_spotlight_optout").select("email").eq("email", email).maybeSingle();
    const spotlightOptOut = Boolean(optOutRow);
    const { data: birthdayRow } = await adminClient.from("hanjogo_birthday_optin").select("email").eq("email", email).maybeSingle();
    const birthdayOptIn = Boolean(birthdayRow);
    let birthdayKnown: boolean | null = null;
    try { birthdayKnown = (await birthdayIndex()).days.has(email); } catch { /* 모르면 안내만 생략합니다. */ }
    const override = await myOverride();
    if (override) {
      return json({ allowed: true, source: "site", email, spotlightOptOut, birthdayOptIn, birthdayKnown, draft: profileDraftFromOverride(override) });
    }
    // 아직 사이트에서 고친 적이 없으면 구글 폼 답변을 가져와 채워줍니다.
    try {
      const rows = latestProfileRowsByEmail(rowsAsObjects(await fetchCsv(PROFILE_CSV_URL)));
      const row = rows.find((item) =>
        normalizeEmail(getField(item, "Email Address") || getField(item, "이메일")) === email
      );
      if (row) return json({ allowed: true, source: "form", email, spotlightOptOut, birthdayOptIn, birthdayKnown, draft: profileDraftFromCsv(row) });
    } catch {
      return json({ allowed: true, source: "unavailable", email, error: "profile_source_unavailable" }, 503);
    }
    // 폼에도 없으면 졸업생 DB의 이름과 기수로 시작합니다.
    let name = "";
    let generation: number | null = null;
    try {
      const person = (await alumniPeople()).find((item) => item.email === email);
      if (person) {
        name = person.name;
        generation = person.generation;
      }
    } catch { /* 이름 없이 빈 양식으로 시작합니다. */ }
    return json({
      allowed: true,
      source: "new",
      email,
      spotlightOptOut,
      birthdayOptIn,
      birthdayKnown,
      draft: {
        name, generation, displayMode: "masked", publicFields: ["gen"],
        company: "", work: "", activity: "", region: "", instagram: "", bio: "", connect: "",
        allowEmailContact: false, attendeeVisible: true, consent: false, helpTopics: [],
      },
    });
  }

  if (action === "profile_save") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const cleaned = cleanProfileDraft(body);
    if ("error" in cleaned) return json({ error: cleaned.error }, 400);
    const { error } = await adminClient
      .from("hanjogo_profile_overrides")
      .upsert(draftToOverrideRow(cleaned, email), { onConflict: "email" });
    if (error) return json({ error: error.message }, 500);
    publicPeopleCache = null;
    return json({ ok: true, draft: cleaned });
  }

  // ---- 행사 사진 ------------------------------------------------------------
  // 동문 인증한 사람만 보고 올립니다. 파일은 비공개 저장소에 두고 짧게 쓰는 주소만 내려보냅니다.
  // 휴대폰에서 줄인 큰 사진(.jpg)과 바둑판용 작은 사진(_t.jpg)을 한 쌍으로 올립니다.
  if (action.startsWith("photo_")) {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const photoBucket = adminClient.storage.from("hanjogo-event-photos");
    const EVENT_KEY = "2026-10-18";
    const PHOTO_LIMIT_PER_PERSON = 60;
    const URL_SECONDS = 60 * 60;

    if (action === "photo_upload_urls") {
      const count = Number(body.count);
      if (!Number.isInteger(count) || count < 1 || count > 10) return json({ error: "invalid_count" }, 400);
      const { count: mine, error: countError } = await adminClient.from("hanjogo_event_photos")
        .select("id", { count: "exact", head: true }).eq("user_id", userId);
      if (countError) return json({ error: countError.message }, 500);
      if (!isAdmin && (mine || 0) + count > PHOTO_LIMIT_PER_PERSON) return json({ error: "photo_limit" }, 400);
      const slots = [];
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID();
        const photo = await photoBucket.createSignedUploadUrl(`${userId}/${id}.jpg`);
        const thumb = await photoBucket.createSignedUploadUrl(`${userId}/${id}_t.jpg`);
        if (photo.error || thumb.error) return json({ error: (photo.error || thumb.error)!.message }, 500);
        slots.push({ photo: { path: photo.data.path, token: photo.data.token }, thumb: { path: thumb.data.path, token: thumb.data.token } });
      }
      return json({ ok: true, slots });
    }

    if (action === "photo_create") {
      const items = Array.isArray(body.items) ? body.items.slice(0, 10) as Record<string, unknown>[] : [];
      if (!items.length) return json({ error: "invalid_request" }, 400);
      // 자기 폴더에 실제로 올라간 파일 쌍만 등록합니다.
      const { data: listed, error: listError } = await photoBucket.list(userId, { limit: 1000 });
      if (listError) return json({ error: listError.message }, 500);
      const present = new Set((listed || []).map((item) => `${userId}/${item.name}`));
      const me = await displayIdentity();
      const rows = [];
      for (const item of items) {
        const photoPath = String(item.photoPath || "");
        const match = photoPath.match(/^([0-9a-f-]{36})\/([0-9a-f-]{36})\.jpg$/);
        if (!match || match[1] !== userId) return json({ error: "invalid_file" }, 400);
        const thumbPath = `${userId}/${match[2]}_t.jpg`;
        if (!present.has(photoPath) || !present.has(thumbPath)) return json({ error: "upload_missing" }, 400);
        const width = Number(item.width), height = Number(item.height);
        rows.push({
          event_key: EVENT_KEY, user_id: userId, author_name: me.display_name, author_generation: me.generation,
          photo_path: photoPath, thumb_path: thumbPath,
          width: Number.isInteger(width) && width > 0 && width <= 10000 ? width : null,
          height: Number.isInteger(height) && height > 0 && height <= 10000 ? height : null,
          caption: cleanBoardText(item.caption, 200) || null,
        });
      }
      const { error } = await adminClient.from("hanjogo_event_photos").insert(rows);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, added: rows.length });
    }

    if (action === "photo_list") {
      const before = Number(body.before);
      let query = adminClient.from("hanjogo_event_photos")
        .select("id,user_id,author_name,author_generation,photo_path,thumb_path,width,height,caption,created_at")
        .eq("event_key", EVENT_KEY).order("id", { ascending: false }).limit(60);
      if (Number.isFinite(before) && before > 0) query = query.lt("id", before);
      const [{ data: photos, error }, { count: total }] = await Promise.all([
        query,
        adminClient.from("hanjogo_event_photos").select("id", { count: "exact", head: true }).eq("event_key", EVENT_KEY),
      ]);
      if (error) return json({ error: error.message }, 500);
      const list = photos || [];
      if (!list.length) return json({ allowed: true, items: [], total: total || 0 });
      const ids = list.map((photo) => photo.id);
      const [{ data: likes, error: likeError }, thumbs, fulls] = await Promise.all([
        adminClient.from("hanjogo_event_photo_likes").select("photo_id,user_id").in("photo_id", ids),
        photoBucket.createSignedUrls(list.map((photo) => String(photo.thumb_path)), URL_SECONDS),
        photoBucket.createSignedUrls(list.map((photo) => String(photo.photo_path)), URL_SECONDS),
      ]);
      if (likeError) return json({ error: likeError.message }, 500);
      if (thumbs.error || fulls.error) return json({ error: (thumbs.error || fulls.error)!.message }, 500);
      const urlOf = (rows: { path: string | null; signedUrl: string }[] | null) =>
        new Map((rows || []).map((row) => [String(row.path || ""), row.signedUrl]));
      const thumbUrls = urlOf(thumbs.data), fullUrls = urlOf(fulls.data);
      return json({
        allowed: true,
        total: total || list.length,
        items: list.map((photo) => {
          const photoLikes = (likes || []).filter((like) => like.photo_id === photo.id);
          return {
            id: photo.id,
            thumbUrl: thumbUrls.get(String(photo.thumb_path)) || "",
            url: fullUrls.get(String(photo.photo_path)) || "",
            width: photo.width, height: photo.height,
            caption: photo.caption || "",
            authorName: photo.author_name, authorGeneration: photo.author_generation,
            createdAt: photo.created_at,
            likeCount: photoLikes.length,
            liked: photoLikes.some((like) => like.user_id === userId),
            canDelete: isAdmin || photo.user_id === userId,
          };
        }),
      });
    }

    const id = Number(body.id);
    if (!Number.isFinite(id)) return json({ error: "invalid_request" }, 400);

    if (action === "photo_like") {
      const on = Boolean(body.on);
      const { data: photo } = await adminClient.from("hanjogo_event_photos").select("id").eq("id", id).maybeSingle();
      if (!photo) return json({ error: "not_found" }, 404);
      const result = on
        ? await adminClient.from("hanjogo_event_photo_likes").upsert({ photo_id: id, user_id: userId }, { onConflict: "photo_id,user_id" })
        : await adminClient.from("hanjogo_event_photo_likes").delete().eq("photo_id", id).eq("user_id", userId);
      if (result.error) return json({ error: result.error.message }, 500);
      const { count } = await adminClient.from("hanjogo_event_photo_likes").select("photo_id", { count: "exact", head: true }).eq("photo_id", id);
      return json({ ok: true, liked: on, likeCount: count || 0 });
    }

    if (action === "photo_delete") {
      const { data: photo, error: lookupError } = await adminClient.from("hanjogo_event_photos")
        .select("id,user_id,photo_path,thumb_path").eq("id", id).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!photo) return json({ error: "not_found" }, 404);
      if (!isAdmin && photo.user_id !== userId) return json({ error: "forbidden" }, 403);
      const { error } = await adminClient.from("hanjogo_event_photos").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      await photoBucket.remove([String(photo.photo_path), String(photo.thumb_path)]);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  }

  // ---- 즐겨찾기 (관심 동문 · 관심 업장) ------------------------------------
  // 본인 것만 읽고 씁니다. 어떤 요청이 와도 email 은 로그인한 사람의 것입니다.
  if (action.startsWith("favorites_")) {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);

    if (action === "favorites_list") {
      const { data, error } = await adminClient
        .from("hanjogo_favorites").select("kind,ref_id").eq("email", email);
      if (error) return json({ error: error.message }, 500);
      return json({
        allowed: true,
        place: (data || []).filter((row) => row.kind === "place").map((row) => String(row.ref_id)),
        profile: (data || []).filter((row) => row.kind === "profile").map((row) => String(row.ref_id)),
        resource: (data || []).filter((row) => row.kind === "resource").map((row) => String(row.ref_id)),
      });
    }

    const kind = String(body.kind || "");
    if (!["place", "profile", "resource"].includes(kind)) return json({ error: "invalid_kind" }, 400);

    if (action === "favorites_set") {
      const refId = cleanBoardText(body.refId, 100);
      if (!refId) return json({ error: "invalid_favorite" }, 400);
      if (body.on) {
        const { error } = await adminClient.from("hanjogo_favorites")
          .upsert({ email, kind, ref_id: refId }, { onConflict: "email,kind,ref_id", ignoreDuplicates: true });
        if (error) return json({ error: error.message }, 500);
      } else {
        const { error } = await adminClient.from("hanjogo_favorites")
          .delete().eq("email", email).eq("kind", kind).eq("ref_id", refId);
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true });
    }

    // 로그인 전에 이 브라우저에서 눌러둔 별을 계정으로 한 번 옮깁니다.
    if (action === "favorites_add") {
      const refIds = (Array.isArray(body.refIds) ? body.refIds : [])
        .map((value: unknown) => cleanBoardText(value, 100)).filter(Boolean).slice(0, 500);
      if (!refIds.length) return json({ ok: true, added: 0 });
      const { error } = await adminClient.from("hanjogo_favorites")
        .upsert(refIds.map((refId) => ({ email, kind, ref_id: refId })), {
          onConflict: "email,kind,ref_id",
          ignoreDuplicates: true,
        });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, added: refIds.length });
    }
  }

  // ---- 내 업장 -----------------------------------------------------------
  if (action === "place_mine") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const [places, submissions, claims] = await Promise.all([
      adminClient.from("hanjogo_alumni_places")
        .select("id,name,owner_name,owner_generation,category,region,address,instagram_url,website_url,booking_url,description,is_published")
        .ilike("owner_email", email).order("name"),
      adminClient.from("hanjogo_alumni_place_submissions")
        .select("id,name,status,created_at").eq("user_id", userId).order("created_at", { ascending: false }),
      adminClient.from("hanjogo_alumni_place_claims")
        .select("id,place_id,status,created_at").eq("user_id", userId).order("created_at", { ascending: false }),
    ]);
    for (const result of [places, submissions, claims]) {
      if (result.error) return json({ error: result.error.message }, 500);
    }
    return json({
      allowed: true,
      places: places.data || [],
      submissions: submissions.data || [],
      claims: claims.data || [],
    });
  }

  /** Owner emails for the map's "이메일로 연락" button. Only owners who allowed
   * email contact (site profile first, then the contact-consent table, then the
   * form answer) are listed, and only to verified alumni. Anyone else's
   * owner_email never leaves the server. */
  if (action === "place_contacts") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const [places, overrideRows, consentRows] = await Promise.all([
      adminClient.from("hanjogo_alumni_places").select("id,owner_email").eq("is_published", true),
      adminClient.from("hanjogo_profile_overrides").select("email,allow_email_contact"),
      adminClient.from("hanjogo_email_contact_consent").select("email,allow_email_contact"),
    ]);
    for (const result of [places, overrideRows, consentRows]) {
      if (result.error) return json({ error: result.error.message }, 500);
    }
    const consent = new Map<string, boolean>();
    (consentRows.data || []).forEach((row) => consent.set(normalizeEmail(row.email), Boolean(row.allow_email_contact)));
    (overrideRows.data || []).forEach((row) => consent.set(normalizeEmail(row.email), Boolean(row.allow_email_contact)));
    const owners = new Set((places.data || []).map((place) => normalizeEmail(place.owner_email)).filter(Boolean));
    if ([...owners].some((owner) => !consent.has(owner))) {
      try {
        latestProfileRowsByEmail(rowsAsObjects(await fetchCsv(PROFILE_CSV_URL))).forEach((row) => {
          const rowEmail = normalizeEmail(getField(row, "Email Address") || getField(row, "이메일"));
          if (!rowEmail || consent.has(rowEmail) || !owners.has(rowEmail)) return;
          const answer = getField(row, "동문들이 한조고 네트워크를 통해 이메일로 직접 연락할 수 있도록 허용하시겠습니까?");
          consent.set(rowEmail, answer.includes("허용합니다"));
        });
      } catch { /* 폼을 못 읽으면 사이트·동의 표에 있는 사람만 보여줍니다. */ }
    }
    const contacts = (places.data || [])
      .map((place) => ({ id: place.id, email: normalizeEmail(place.owner_email) }))
      .filter((place) => place.email && consent.get(place.email) === true);
    const me = await boardIdentity(email, special, await myOverride());
    return json({ allowed: true, contacts, me });
  }

  if (action === "place_save") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const id = Number(body.id);
    if (!Number.isFinite(id)) return json({ error: "invalid_place" }, 400);
    const cleaned = cleanPlaceInput(body);
    if ("error" in cleaned) return json({ error: cleaned.error }, 400);
    const { data: target, error: lookupError } = await adminClient
      .from("hanjogo_alumni_places").select("id,owner_email,address").eq("id", id).maybeSingle();
    if (lookupError) return json({ error: lookupError.message }, 500);
    if (!target) return json({ error: "not_found" }, 404);
    if (normalizeEmail(target.owner_email) !== email) return json({ error: "forbidden" }, 403);
    const patch: Record<string, unknown> = { ...cleaned.value, updated_at: new Date().toISOString() };
    // 주소가 바뀌면 좌표를 다시 확인해야 합니다.
    if (patch.address !== target.address) patch.is_address_verified = false;
    const { error } = await adminClient.from("hanjogo_alumni_places").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- 번개·소모임 ---------------------------------------------------------
  if (action.startsWith("meetup_")) {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);

    async function loadMeetup(id: number) {
      const { data, error } = await adminClient.from("hanjogo_meetups").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data && !data.is_hidden ? data : null;
    }

    if (action === "meetup_list") {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: meetups, error } = await adminClient.from("hanjogo_meetups")
        .select("id,host_user_id,host_display_name,host_generation,title,category,starts_at,region,place,capacity,description,status,created_at")
        .eq("is_hidden", false).gte("starts_at", since).order("starts_at").limit(200);
      if (error) return json({ error: error.message }, 500);
      // 취소된 모임은 날짜가 지나면 더 보여줄 필요가 없습니다.
      const now = Date.now();
      const visible = (meetups || []).filter((m) => m.status !== "cancelled" || new Date(m.starts_at).getTime() >= now);
      const ids = visible.map((m) => m.id);
      let attendees: Record<string, unknown>[] = [];
      let comments: Record<string, unknown>[] = [];
      if (ids.length) {
        const [a, c] = await Promise.all([
          adminClient.from("hanjogo_meetup_attendees")
            .select("meetup_id,user_id,email,display_name,generation,created_at").in("meetup_id", ids).order("created_at"),
          adminClient.from("hanjogo_meetup_comments")
            .select("id,meetup_id,user_id,display_name,generation,content,created_at")
            .in("meetup_id", ids).eq("is_hidden", false).order("created_at"),
        ]);
        if (a.error) return json({ error: a.error.message }, 500);
        if (c.error) return json({ error: c.error.message }, 500);
        attendees = a.data || [];
        comments = c.data || [];
      }
      const items = visible.map((m) => {
        const isHost = m.host_user_id === userId;
        const going = attendees.filter((row) => row.meetup_id === m.id);
        return {
          id: m.id, title: m.title, category: m.category, startsAt: m.starts_at,
          region: m.region, place: m.place, capacity: m.capacity, description: m.description,
          status: m.status, hostName: m.host_display_name, hostGeneration: m.host_generation,
          isHost, canEdit: isHost || isAdmin,
          joined: going.some((row) => row.user_id === userId),
          attendeeCount: going.length,
          attendees: going.map((row) => ({ name: row.display_name, generation: row.generation })),
          // 참석자 이메일은 주최자에게만 보냅니다(전체 연락용).
          attendeeEmails: isHost ? going.filter((row) => row.user_id !== userId).map((row) => row.email) : [],
          comments: comments.filter((row) => row.meetup_id === m.id).map((row) => ({
            id: row.id, name: row.display_name, generation: row.generation, content: row.content,
            createdAt: row.created_at, canDelete: isAdmin || row.user_id === userId,
          })),
        };
      });
      return json({ allowed: true, isAdmin, items });
    }

    if (action === "meetup_create") {
      const cleaned = cleanMeetupInput(body);
      if ("error" in cleaned) return json({ error: cleaned.error }, 400);
      const me = await displayIdentity();
      const { data, error } = await adminClient.from("hanjogo_meetups").insert({
        ...cleaned.value, host_user_id: userId, host_email: email,
        host_display_name: me.display_name, host_generation: me.generation,
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      // 모임을 연 사람은 자동으로 첫 참석자가 됩니다.
      const { error: joinError } = await adminClient.from("hanjogo_meetup_attendees").insert({
        meetup_id: data.id, user_id: userId, email, display_name: me.display_name, generation: me.generation,
      });
      if (joinError) return json({ error: joinError.message }, 500);
      return json({ ok: true, id: data.id });
    }

    const meetupId = Number(body.id);
    if (!Number.isFinite(meetupId)) return json({ error: "invalid_meetup" }, 400);
    let meetup: Record<string, unknown> | null;
    try {
      meetup = await loadMeetup(meetupId);
    } catch (e) {
      return json({ error: String((e as Error).message || e) }, 500);
    }
    if (!meetup) return json({ error: "not_found" }, 404);
    const canEdit = isAdmin || meetup.host_user_id === userId;

    if (action === "meetup_update") {
      if (!canEdit) return json({ error: "forbidden" }, 403);
      const cleaned = cleanMeetupInput(body);
      if ("error" in cleaned) return json({ error: cleaned.error }, 400);
      if (cleaned.value.capacity !== null) {
        const { count, error: countError } = await adminClient.from("hanjogo_meetup_attendees")
          .select("user_id", { count: "exact", head: true }).eq("meetup_id", meetupId);
        if (countError) return json({ error: countError.message }, 500);
        if ((count || 0) > cleaned.value.capacity) return json({ error: "capacity_below_attendees" }, 400);
      }
      const { error } = await adminClient.from("hanjogo_meetups")
        .update({ ...cleaned.value, updated_at: new Date().toISOString() }).eq("id", meetupId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "meetup_cancel") {
      if (!canEdit) return json({ error: "forbidden" }, 403);
      // 주최자 말고 신청한 사람이 없으면 알릴 사람이 없으니 아예 지웁니다.
      // 신청한 사람이 있으면 "취소됨"으로 남겨 참석자가 알 수 있게 합니다(날짜가 지나면 목록에서 빠집니다).
      const { count, error: countError } = await adminClient.from("hanjogo_meetup_attendees")
        .select("user_id", { count: "exact", head: true }).eq("meetup_id", meetupId).neq("user_id", String(meetup.host_user_id));
      if (countError) return json({ error: countError.message }, 500);
      if (!count) {
        const { error } = await adminClient.from("hanjogo_meetups").delete().eq("id", meetupId);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, deleted: true });
      }
      const { error } = await adminClient.from("hanjogo_meetups")
        .update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", meetupId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "meetup_hide") {
      if (!isAdmin) return json({ error: "admin_only" }, 403);
      const { error } = await adminClient.from("hanjogo_meetups")
        .update({ is_hidden: true, updated_at: new Date().toISOString() }).eq("id", meetupId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "meetup_join") {
      const me = await displayIdentity();
      const { data, error } = await adminClient.rpc("hanjogo_meetup_join", {
        p_meetup_id: meetupId, p_user_id: userId, p_email: email,
        p_display_name: me.display_name, p_generation: me.generation,
      });
      if (error) return json({ error: error.message }, 500);
      if (data !== "ok") return json({ error: String(data) }, 409);
      return json({ ok: true });
    }

    if (action === "meetup_leave") {
      if (meetup.host_user_id === userId) return json({ error: "host_cannot_leave" }, 400);
      const { error } = await adminClient.from("hanjogo_meetup_attendees")
        .delete().eq("meetup_id", meetupId).eq("user_id", userId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "meetup_comment_create") {
      const content = cleanBoardText(body.content, 500);
      if (!content) return json({ error: "invalid_comment" }, 400);
      const me = await displayIdentity();
      const { error } = await adminClient.from("hanjogo_meetup_comments").insert({
        meetup_id: meetupId, user_id: userId, display_name: me.display_name, generation: me.generation, content,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "meetup_comment_delete") {
      const commentId = Number(body.commentId);
      if (!Number.isFinite(commentId)) return json({ error: "invalid_comment" }, 400);
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_meetup_comments")
        .select("id,user_id").eq("id", commentId).eq("meetup_id", meetupId).eq("is_hidden", false).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target) return json({ error: "not_found" }, 404);
      if (!isAdmin && target.user_id !== userId) return json({ error: "forbidden" }, 403);
      const { error } = await adminClient.from("hanjogo_meetup_comments").update({ is_hidden: true }).eq("id", commentId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  }

  // ---- 알림 (🔔) -----------------------------------------------------------
  // 본인 것만 봅니다. 태그됐을 때, 내 글에 답변·댓글이 달렸을 때 생깁니다.
  if (action === "notifications_list") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const { data, error } = await adminClient.from("hanjogo_notifications")
      .select("id,kind,post_id,title,actor_name,actor_generation,created_at,read_at")
      .eq("recipient_email", email).order("created_at", { ascending: false }).limit(50);
    if (error) return json({ error: error.message }, 500);
    const items = (data || []).map((row) => ({
      id: row.id, kind: row.kind, postId: row.post_id, title: row.title,
      actorName: row.actor_name, actorGeneration: row.actor_generation, createdAt: row.created_at, read: Boolean(row.read_at),
    }));
    return json({ allowed: true, items, unread: items.filter((item) => !item.read).length });
  }

  if (action === "notifications_read") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const { error } = await adminClient.from("hanjogo_notifications")
      .update({ read_at: new Date().toISOString() }).eq("recipient_email", email).is("read_at", null);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action.startsWith("board_")) {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    // 우리 기수 글: 보는 사람의 기수는 인증 정보(프로필·졸업생 DB)로 정합니다. 관리자는 모두 봅니다.
    let viewerGeneration: number | null | undefined;
    const myGeneration = async () => {
      if (viewerGeneration === undefined) viewerGeneration = validGeneration((await boardIdentity(email, special, await myOverride())).generation);
      return viewerGeneration;
    };
    const canSee = async (post: Record<string, unknown>) =>
      post.category !== "generation" || isAdmin || (post.target_generation != null && Number(post.target_generation) === await myGeneration());
    // 자료 공유 첨부파일은 비공개 저장소에 두고, 올릴 때·받을 때마다 짧게 쓰는 주소를 만듭니다.
    const bucket = adminClient.storage.from("hanjogo-resources");
    /** Checks an uploaded file really is in this user's folder; returns the columns to save. */
    const uploadedFile = async (): Promise<{ file_path: string; file_name: string; file_size: number } | { error: string }> => {
      const path = String(body.filePath || "");
      const fileName = cleanBoardText(body.fileName, 200);
      // 남의 폴더 파일을 자기 자료로 등록하지 못하게 합니다.
      if (!path.startsWith(`${userId}/`) || path.includes("..") || !resourceExtension(path) || !resourceExtension(fileName)) {
        return { error: "invalid_file" };
      }
      const { data: listed, error: listError } = await bucket.list(userId, { search: path.slice(userId.length + 1) });
      if (listError) return { error: listError.message };
      const object = (listed || []).find((item) => `${userId}/${item.name}` === path);
      if (!object) return { error: "upload_missing" };
      const size = Number((object.metadata as Record<string, unknown> | null)?.size || body.fileSize || 0);
      return { file_path: path, file_name: fileName, file_size: Math.min(Math.max(size, 1), RESOURCE_MAX_BYTES) };
    };
    if (action === "board_upload_url") {
      const ext = resourceExtension(body.fileName);
      if (!ext) return json({ error: "invalid_file_type" }, 400);
      const size = Number(body.fileSize);
      if (!Number.isInteger(size) || size < 1 || size > RESOURCE_MAX_BYTES) return json({ error: "file_too_large" }, 400);
      // 저장 경로는 올린 사람 폴더 아래에 둡니다. 원래 파일 이름은 표에만 적습니다.
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, path: data.path, token: data.token });
    }
    if (action === "board_download") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: "invalid_post" }, 400);
      const { data: post, error: postError } = await adminClient.from("hanjogo_board_posts")
        .select("id,category,file_path,file_name,link_url,download_count").eq("id", id).eq("is_hidden", false).maybeSingle();
      if (postError) return json({ error: postError.message }, 500);
      if (!post || post.category !== "resource") return json({ error: "not_found" }, 404);
      let url = String(post.link_url || "");
      if (post.file_path) {
        const { data, error } = await bucket.createSignedUrl(String(post.file_path), 300, { download: String(post.file_name || "") || true });
        if (error) return json({ error: error.message }, 500);
        url = data.signedUrl;
      }
      if (!url) return json({ error: "not_found" }, 404);
      await adminClient.from("hanjogo_board_posts").update({ download_count: Number(post.download_count || 0) + 1 }).eq("id", id);
      return json({ ok: true, url });
    }
    if (action === "board_list") {
      const { data: rawPosts, error: postsError } = await adminClient.from("hanjogo_board_posts")
        .select("id,author_id,author_name,author_generation,category,target_generation,title,content,topic,is_resolved,is_notice,file_path,file_name,file_size,link_url,download_count,created_at,updated_at")
        .eq("is_hidden", false).order("is_notice", { ascending: false }).order("created_at", { ascending: false }).limit(150);
      if (postsError) return json({ error: postsError.message }, 500);
      const visible: Record<string, unknown>[] = [];
      for (const post of rawPosts || []) if (await canSee(post)) visible.push(post);
      const posts = visible.slice(0, 100);
      const postIds = (posts || []).map((post) => post.id);
      let comments: Record<string, unknown>[] = [];
      let reactions: Record<string, unknown>[] = [];
      let views: Record<string, unknown>[] = [];
      if (postIds.length) {
        const [commentResult, reactionResult, viewResult] = await Promise.all([
          adminClient.from("hanjogo_board_comments")
            .select("id,post_id,author_id,author_name,author_generation,content,created_at")
            .in("post_id", postIds).eq("is_hidden", false).order("created_at", { ascending: true }),
          adminClient.from("hanjogo_board_reactions").select("post_id,user_id,reaction").in("post_id", postIds),
          adminClient.from("hanjogo_board_views").select("post_id").in("post_id", postIds),
        ]);
        if (commentResult.error) return json({ error: commentResult.error.message }, 500);
        if (reactionResult.error) return json({ error: reactionResult.error.message }, 500);
        if (viewResult.error) return json({ error: viewResult.error.message }, 500);
        comments = commentResult.data || [];
        reactions = reactionResult.data || [];
        views = viewResult.data || [];
      }
      // 선후배 질문: 분야별로 도와줄 수 있는 동문과 @태그할 수 있는 동문(공개 프로필만, 각자 고른 이름 표시 방식).
      let people: PublicPerson[] = [];
      try { people = await publicPeople(); } catch { /* 폼을 못 읽으면 목록 없이 보여줍니다. */ }
      const helpersByTopic: Record<string, { profileId: string; name: string; generation: number | null }[]> = {};
      HELP_TOPICS.forEach((topic) => { helpersByTopic[topic] = []; });
      people.forEach((person) => person.topics.forEach((topic) => {
        helpersByTopic[topic].push({ profileId: person.profileId, name: person.name, generation: person.generation });
      }));
      const mentionable = people.map((person) => ({ profileId: person.profileId, name: person.name, generation: person.generation }));
      return json({ allowed: true, isAdmin, myGeneration: await myGeneration(), helpTopics: HELP_TOPICS, helpersByTopic, people: mentionable, items: (posts || []).map((post) => publicBoardPost(
        post,
        comments.filter((comment) => comment.post_id === post.id),
        reactions.filter((reaction) => reaction.post_id === post.id),
        views.filter((view) => view.post_id === post.id).length,
        userId,
        isAdmin,
      )) });
    }
    if (action === "board_view") {
      const postId = Number(body.postId);
      if (!Number.isFinite(postId)) return json({ error: "invalid_post" }, 400);
      const { data: post, error: postError } = await adminClient.from("hanjogo_board_posts").select("id,category,target_generation").eq("id", postId).eq("is_hidden", false).maybeSingle();
      if (postError) return json({ error: postError.message }, 500);
      if (!post || !await canSee(post)) return json({ error: "post_not_found" }, 404);
      const { error } = await adminClient.from("hanjogo_board_views").upsert(
        { post_id: postId, user_id: userId },
        { onConflict: "post_id,user_id", ignoreDuplicates: true },
      );
      if (error) return json({ error: error.message }, 500);
      const { count, error: countError } = await adminClient.from("hanjogo_board_views").select("post_id", { count: "exact", head: true }).eq("post_id", postId);
      if (countError) return json({ error: countError.message }, 500);
      return json({ ok: true, viewCount: count || 0 });
    }
    if (action === "board_react") {
      const postId = Number(body.postId);
      const reaction = cleanBoardText(body.reaction, 20);
      if (!Number.isFinite(postId) || !["like", "heart", "clap", "useful"].includes(reaction)) return json({ error: "invalid_reaction" }, 400);
      const { data: post, error: postError } = await adminClient.from("hanjogo_board_posts").select("id,category,target_generation").eq("id", postId).eq("is_hidden", false).maybeSingle();
      if (postError) return json({ error: postError.message }, 500);
      if (!post || !await canSee(post)) return json({ error: "post_not_found" }, 404);
      const { data: existing, error: lookupError } = await adminClient.from("hanjogo_board_reactions")
        .select("post_id").eq("post_id", postId).eq("user_id", userId).eq("reaction", reaction).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (existing) {
        const { error } = await adminClient.from("hanjogo_board_reactions").delete().eq("post_id", postId).eq("user_id", userId).eq("reaction", reaction);
        if (error) return json({ error: error.message }, 500);
      } else {
        const { error } = await adminClient.from("hanjogo_board_reactions").insert({ post_id: postId, user_id: userId, reaction });
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true, active: !existing });
    }
    if (action === "board_create") {
      const category = cleanBoardText(body.category, 20);
      const title = cleanBoardText(body.title, 120);
      const content = cleanBoardText(body.content, 5000);
      if (!BOARD_CATEGORIES.includes(category) || !title || !content) return json({ error: "invalid_post" }, 400);
      if (category === "notice" && !isAdmin) return json({ error: "admin_only" }, 403);
      const picked = boardTopic(category, body.topic);
      if ("error" in picked) return json({ error: picked.error }, 400);
      const attachment = boardAttachmentLink(category, body);
      if ("error" in attachment) return json({ error: attachment.error }, 400);
      let file: { file_path: string; file_name: string; file_size: number } | null = null;
      if (category === "resource" && body.filePath) {
        const checked = await uploadedFile();
        if ("error" in checked) return json({ error: checked.error }, 400);
        file = checked;
      }
      if (category === "resource" && !file && !attachment.link) return json({ error: "file_or_link_required" }, 400);
      const identity = await boardIdentity(email, special, await myOverride());
      // 우리 기수 글은 쓴 사람의 기수로만 올라갑니다. 기수를 알 수 없으면 쓸 수 없습니다.
      const targetGeneration = category === "generation" ? validGeneration(identity.generation) : null;
      if (category === "generation" && targetGeneration == null) return json({ error: "generation_unknown" }, 400);
      const { data, error } = await adminClient.from("hanjogo_board_posts").insert({
        author_id: userId, author_email: email, author_name: identity.name,
        author_generation: identity.generation, category, target_generation: targetGeneration, title, content, topic: picked.topic, is_notice: category === "notice",
        link_url: attachment.link, ...(file || {}),
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      // 다른 기수에게 보이지 않는 글이라 @태그 알림은 보내지 않습니다.
      if (category !== "generation") await notifyMentions(cleanMentions(body.mentions), data.id, title, identity, new Set());
      return json({ ok: true, id: data.id });
    }
    if (action === "board_update") {
      const id = Number(body.id);
      const category = cleanBoardText(body.category, 20);
      const title = cleanBoardText(body.title, 120);
      const content = cleanBoardText(body.content, 5000);
      if (!Number.isFinite(id) || !BOARD_CATEGORIES.includes(category) || !title || !content) return json({ error: "invalid_post" }, 400);
      if (category === "notice" && !isAdmin) return json({ error: "admin_only" }, 403);
      const picked = boardTopic(category, body.topic);
      if ("error" in picked) return json({ error: picked.error }, 400);
      const attachment = boardAttachmentLink(category, body);
      if ("error" in attachment) return json({ error: attachment.error }, 400);
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_board_posts").select("id,author_id,file_path,category").eq("id", id).eq("is_hidden", false).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target) return json({ error: "not_found" }, 404);
      if (!isAdmin && target.author_id !== userId) return json({ error: "forbidden" }, 403);
      // 우리 기수 글과 다른 분류 사이로는 옮길 수 없습니다(보는 사람 범위가 바뀌기 때문).
      if ((target.category === "generation") !== (category === "generation")) return json({ error: "category_locked" }, 400);
      // 첨부: 새 파일을 올리면 바꾸고, 지우기를 고르면 빼고, 아니면 그대로 둡니다. 자료 공유가 아니면 첨부를 모두 뺍니다.
      const oldPath = target.file_path ? String(target.file_path) : "";
      let fileColumns: Record<string, unknown> = {};
      let keepsFile = Boolean(oldPath);
      if (category !== "resource" || body.removeFile) {
        fileColumns = { file_path: null, file_name: null, file_size: null };
        keepsFile = false;
      }
      if (category === "resource" && body.filePath) {
        const checked = await uploadedFile();
        if ("error" in checked) return json({ error: checked.error }, 400);
        fileColumns = checked;
        keepsFile = true;
      }
      if (category === "resource" && !keepsFile && !attachment.link) return json({ error: "file_or_link_required" }, 400);
      const { error } = await adminClient.from("hanjogo_board_posts").update({
        category, title, content, topic: picked.topic, is_notice: category === "notice",
        link_url: attachment.link, ...fileColumns, updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      if (oldPath && "file_path" in fileColumns && fileColumns.file_path !== oldPath) await bucket.remove([oldPath]);
      return json({ ok: true });
    }
    // 선후배 질문: 질문한 사람(또는 관리자)이 해결됨을 표시합니다.
    if (action === "board_resolve") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: "invalid_post" }, 400);
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_board_posts").select("id,author_id,category").eq("id", id).eq("is_hidden", false).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target || target.category !== "question") return json({ error: "not_found" }, 404);
      if (!isAdmin && target.author_id !== userId) return json({ error: "forbidden" }, 403);
      const { error } = await adminClient.from("hanjogo_board_posts").update({ is_resolved: Boolean(body.resolved) }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "board_delete") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: "invalid_post" }, 400);
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_board_posts").select("id,author_id,file_path").eq("id", id).eq("is_hidden", false).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target) return json({ error: "not_found" }, 404);
      if (!isAdmin && target.author_id !== userId) return json({ error: "forbidden" }, 403);
      const { error } = await adminClient.from("hanjogo_board_posts").update({ is_hidden: true, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      if (target.file_path) await bucket.remove([String(target.file_path)]);
      return json({ ok: true });
    }
    if (action === "board_comment_create") {
      const postId = Number(body.postId);
      const content = cleanBoardText(body.content, 1000);
      if (!Number.isFinite(postId) || !content) return json({ error: "invalid_comment" }, 400);
      const { data: post, error: postError } = await adminClient.from("hanjogo_board_posts").select("id,title,category,target_generation,author_email").eq("id", postId).eq("is_hidden", false).maybeSingle();
      if (postError) return json({ error: postError.message }, 500);
      if (!post || !await canSee(post)) return json({ error: "post_not_found" }, 404);
      const identity = await boardIdentity(email, special, await myOverride());
      const { error } = await adminClient.from("hanjogo_board_comments").insert({
        post_id: postId, author_id: userId, author_email: email, author_name: identity.name,
        author_generation: identity.generation, content,
      });
      if (error) return json({ error: error.message }, 500);
      // 글쓴이에게 새 답변(댓글)을 알리고, 태그한 동문에게도 알립니다. 같은 사람에게 두 번 보내지 않습니다.
      const notified = new Set<string>();
      const author = normalizeEmail(post.author_email);
      if (author && author !== email) {
        notified.add(author);
        await adminClient.from("hanjogo_notifications").insert({
          recipient_email: author, kind: post.category === "question" ? "answer" : "comment", post_id: postId,
          title: cleanBoardText(post.title, 120), actor_name: identity.name, actor_generation: validGeneration(identity.generation),
        });
      }
      if (post.category !== "generation") await notifyMentions(cleanMentions(body.mentions), postId, String(post.title || ""), identity, notified);
      return json({ ok: true });
    }
    if (action === "board_comment_delete") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: "invalid_comment" }, 400);
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_board_comments").select("id,author_id").eq("id", id).eq("is_hidden", false).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target) return json({ error: "not_found" }, 404);
      if (!isAdmin && target.author_id !== userId) return json({ error: "forbidden" }, 403);
      const { error } = await adminClient.from("hanjogo_board_comments").update({ is_hidden: true, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
  }

  if (email !== ADMIN_EMAIL) return json({ error: "admin_only" }, 403);

  if (action === "list_special") {
    const { data, error } = await adminClient.from("hanjogo_special_access").select("id,email,name,note,created_at,created_by").order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({ items: data || [] });
  }

  if (action === "add_special") {
    const targetEmail = normalizeEmail(body.email);
    const name = String(body.name || "").trim();
    const note = String(body.note || "").trim();
    if (!targetEmail || !targetEmail.includes("@")) return json({ error: "invalid_email" }, 400);
    const { data, error } = await adminClient.from("hanjogo_special_access").upsert({ email: targetEmail, name, note, created_by: email }, { onConflict: "email" }).select("id,email,name,note,created_at,created_by").single();
    if (error) return json({ error: error.message }, 500);
    return json({ item: data });
  }

  if (action === "remove_special") {
    const id = Number(body.id);
    const targetEmail = normalizeEmail(body.email);
    if (targetEmail === ADMIN_EMAIL) return json({ error: "protected_admin" }, 403);
    if (Number.isFinite(id) && id > 0) {
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_special_access").select("id,email").eq("id", id).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target) return json({ error: "not_found" }, 404);
      if (normalizeEmail(target.email) === ADMIN_EMAIL) return json({ error: "protected_admin" }, 403);
      const { error } = await adminClient.from("hanjogo_special_access").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (!targetEmail) return json({ error: "missing_target" }, 400);
    const { error } = await adminClient.from("hanjogo_special_access").delete().eq("email", targetEmail);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- 관리자: 업장 신청 승인과 담당자 연결 -------------------------------
  if (action === "place_requests") {
    const [submissions, claims, places] = await Promise.all([
      adminClient.from("hanjogo_alumni_place_submissions")
        .select("*").eq("status", "pending").order("created_at"),
      adminClient.from("hanjogo_alumni_place_claims")
        .select("*").eq("status", "pending").order("created_at"),
      adminClient.from("hanjogo_alumni_places")
        .select("id,name,owner_name,owner_generation,owner_email").order("name"),
    ]);
    for (const result of [submissions, claims, places]) {
      if (result.error) return json({ error: result.error.message }, 500);
    }
    const placeById = new Map((places.data || []).map((place) => [place.id, place]));
    return json({
      submissions: submissions.data || [],
      claims: (claims.data || []).map((claim) => ({ ...claim, place: placeById.get(claim.place_id) || null })),
      unlinkedCount: (places.data || []).filter((place) => !String(place.owner_email || "").trim()).length,
    });
  }

  if (action === "place_submission_decide") {
    const id = Number(body.id);
    const approve = Boolean(body.approve);
    if (!Number.isFinite(id)) return json({ error: "invalid_request" }, 400);
    const { data: target, error: lookupError } = await adminClient
      .from("hanjogo_alumni_place_submissions").select("*").eq("id", id).eq("status", "pending").maybeSingle();
    if (lookupError) return json({ error: lookupError.message }, 500);
    if (!target) return json({ error: "not_found" }, 404);
    let merged = false;
    if (approve) {
      // 같은 이름·대표자의 업장이 이미 지도에 있으면(다시 신청한 경우) 새로 만들지 않고 그 업장을 새 내용으로 고칩니다.
      // 다른 사람이 운영자로 연결된 업장은 건드리지 않습니다.
      const { data: sameName, error: existingError } = await adminClient.from("hanjogo_alumni_places")
        .select("id,owner_name,owner_email").eq("name", target.name);
      if (existingError) return json({ error: existingError.message }, 500);
      const existing = (sameName || []).find((place) => String(place.owner_name ?? "") === String(target.owner_name ?? ""));
      if (existing) {
        const owner = normalizeEmail(existing.owner_email);
        if (owner && owner !== normalizeEmail(target.email)) return json({ error: "already_listed" });
        const changes: Record<string, unknown> = { owner_email: normalizeEmail(target.email), updated_at: new Date().toISOString() };
        for (const key of ["category", "region", "address", "instagram_url", "website_url", "booking_url", "description"]) {
          if (String(target[key] ?? "").trim()) changes[key] = target[key];
        }
        if (target.owner_generation != null) changes.owner_generation = String(target.owner_generation);
        const { error } = await adminClient.from("hanjogo_alumni_places").update(changes).eq("id", existing.id);
        if (error) return json({ error: error.message }, 500);
        merged = true;
      }
    }
    if (approve && !merged) {
      const { error } = await adminClient.from("hanjogo_alumni_places").insert({
        name: target.name,
        owner_name: target.owner_name,
        owner_generation: target.owner_generation == null ? null : String(target.owner_generation),
        category: target.category, region: target.region, address: target.address,
        instagram_url: target.instagram_url, website_url: target.website_url,
        booking_url: target.booking_url, description: target.description,
        // 신청한 본인이 바로 수정할 수 있도록 담당자로 연결합니다.
        owner_email: normalizeEmail(target.email),
        is_address_verified: false, is_published: true,
      });
      if (error) return json({ error: error.message }, 500);
    }
    const { error } = await adminClient.from("hanjogo_alumni_place_submissions")
      .update({ status: approve ? "approved" : "rejected", updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, merged });
  }

  if (action === "place_claim_decide") {
    const id = Number(body.id);
    const approve = Boolean(body.approve);
    if (!Number.isFinite(id)) return json({ error: "invalid_request" }, 400);
    const { data: target, error: lookupError } = await adminClient
      .from("hanjogo_alumni_place_claims").select("*").eq("id", id).eq("status", "pending").maybeSingle();
    if (lookupError) return json({ error: lookupError.message }, 500);
    if (!target) return json({ error: "not_found" }, 404);
    if (approve) {
      const { error } = await adminClient.from("hanjogo_alumni_places")
        .update({ owner_email: normalizeEmail(target.email), updated_at: new Date().toISOString() })
        .eq("id", target.place_id);
      if (error) return json({ error: error.message }, 500);
    }
    const { error } = await adminClient.from("hanjogo_alumni_place_claims")
      .update({ status: approve ? "approved" : "rejected" }).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  /** Propose owner emails for places that have none, by matching the alumni
   * directory on name AND cohort. A cohort with two people of the same name is
   * reported as ambiguous and never proposed: linking grants edit rights. */
  if (action === "place_owner_matches") {
    let people: { name: string; generation: number | null; email: string }[];
    try {
      people = await alumniPeople();
    } catch {
      return json({ error: "alumni_db_unavailable" }, 503);
    }
    const byNameGeneration = new Map<string, Set<string>>();
    people.forEach((person) => {
      const key = `${normalizeKey(person.name)}|${person.generation}`;
      const emails = byNameGeneration.get(key) || new Set<string>();
      emails.add(person.email);
      byNameGeneration.set(key, emails);
    });
    const { data: places, error } = await adminClient.from("hanjogo_alumni_places")
      .select("id,name,owner_name,owner_generation,owner_email").order("name");
    if (error) return json({ error: error.message }, 500);
    const matched: unknown[] = [];
    const ambiguous: unknown[] = [];
    const unmatched: unknown[] = [];
    (places || []).forEach((place) => {
      if (String(place.owner_email || "").trim()) return;
      const generation = numberFromText(place.owner_generation);
      const emails = [...(byNameGeneration.get(`${normalizeKey(place.owner_name)}|${generation}`) || [])];
      const entry = { id: place.id, name: place.name, ownerName: place.owner_name, ownerGeneration: generation };
      if (emails.length === 1) matched.push({ ...entry, email: emails[0] });
      else if (emails.length > 1) ambiguous.push({ ...entry, count: emails.length });
      else unmatched.push(entry);
    });
    return json({ matched, ambiguous, unmatched });
  }

  if (action === "place_link_owner") {
    const placeId = Number(body.placeId);
    const targetEmail = normalizeEmail(body.email);
    if (!Number.isFinite(placeId) || !targetEmail.includes("@")) return json({ error: "invalid_request" }, 400);
    const { data: target, error: lookupError } = await adminClient
      .from("hanjogo_alumni_places").select("id,owner_email").eq("id", placeId).maybeSingle();
    if (lookupError) return json({ error: lookupError.message }, 500);
    if (!target) return json({ error: "not_found" }, 404);
    // 이미 연결된 업장은 덮어쓰지 않습니다. 바꾸려면 먼저 연결을 해제합니다.
    if (String(target.owner_email || "").trim() && !body.replace) return json({ error: "already_linked" }, 409);
    const { error } = await adminClient.from("hanjogo_alumni_places")
      .update({ owner_email: targetEmail, updated_at: new Date().toISOString() }).eq("id", placeId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "place_unlink_owner") {
    const placeId = Number(body.placeId);
    if (!Number.isFinite(placeId)) return json({ error: "invalid_request" }, 400);
    const { error } = await adminClient.from("hanjogo_alumni_places")
      .update({ owner_email: null, updated_at: new Date().toISOString() }).eq("id", placeId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
