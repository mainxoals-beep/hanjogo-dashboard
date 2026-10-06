import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.117.0";

const ALUMNI_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSuW1LbjftAqI7V9V65eehlY_KQ4JIRwLR80rfUdAQXoFGywIOs4tk1LAuRBJ17pEdAslBjpLaqqCY5/pub?output=csv";
const PROFILE_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQm2qyYr9BAEm-fyZvNyExxiPS9lcRBPi06n__Qq__WlRPvGF_Iou7x1lIjsmBgqpoqHo4M2syaFVxc/pub?gid=648141668&single=true&output=csv";
const ADMIN_EMAIL = "mainxoals@gmail.com";
const ALUMNI_EMAIL_CACHE_TTL = 5 * 60 * 1000;
let alumniEmailCache: { expiresAt: number; emails: Set<string> } | null = null;
let alumniEmailCachePromise: Promise<Set<string>> | null = null;

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
    authorName: row.author_name, authorGeneration: row.author_generation,
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
    sortGen: Number(generation) || 999,
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
    profileId: await stableProfileId(email),
    isOwnProfile: Boolean(email) && email === viewerEmail,
    isNew: Boolean(firstPublicDate) && firstPublicDate === todayKey,
    isRecent: dateKeyWithinDays(firstPublicDate, todayKey, 7),
    sortGen: Number(generation) || 999,
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
      const profiles = [...fromCsv, ...fromSite].filter(Boolean);
      return json({ allowed: true, profiles, count: profiles.length });
    } catch {
      return json({ allowed: true, error: "profiles_unavailable" }, 503);
    }
  }

  // ---- 내 정보: 본인 프로필 보기와 저장 ----------------------------------
  if (action === "profile_me") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    const override = await myOverride();
    if (override) {
      return json({ allowed: true, source: "site", email, draft: profileDraftFromOverride(override) });
    }
    // 아직 사이트에서 고친 적이 없으면 구글 폼 답변을 가져와 채워줍니다.
    try {
      const rows = latestProfileRowsByEmail(rowsAsObjects(await fetchCsv(PROFILE_CSV_URL)));
      const row = rows.find((item) =>
        normalizeEmail(getField(item, "Email Address") || getField(item, "이메일")) === email
      );
      if (row) return json({ allowed: true, source: "form", email, draft: profileDraftFromCsv(row) });
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
      draft: {
        name, generation, displayMode: "masked", publicFields: ["gen"],
        company: "", work: "", activity: "", region: "", instagram: "", bio: "", connect: "",
        allowEmailContact: false, attendeeVisible: true, consent: false,
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
    return json({ ok: true, draft: cleaned });
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
      });
    }

    const kind = String(body.kind || "");
    if (!["place", "profile"].includes(kind)) return json({ error: "invalid_kind" }, 400);

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

  if (action.startsWith("board_")) {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    if (action === "board_list") {
      const { data: posts, error: postsError } = await adminClient.from("hanjogo_board_posts")
        .select("id,author_id,author_name,author_generation,category,title,content,is_notice,created_at,updated_at")
        .eq("is_hidden", false).order("is_notice", { ascending: false }).order("created_at", { ascending: false }).limit(100);
      if (postsError) return json({ error: postsError.message }, 500);
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
      return json({ allowed: true, isAdmin, items: (posts || []).map((post) => publicBoardPost(
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
      const { data: post, error: postError } = await adminClient.from("hanjogo_board_posts").select("id").eq("id", postId).eq("is_hidden", false).maybeSingle();
      if (postError) return json({ error: postError.message }, 500);
      if (!post) return json({ error: "post_not_found" }, 404);
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
      const { data: post, error: postError } = await adminClient.from("hanjogo_board_posts").select("id").eq("id", postId).eq("is_hidden", false).maybeSingle();
      if (postError) return json({ error: postError.message }, 500);
      if (!post) return json({ error: "post_not_found" }, 404);
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
      if (!["free", "jobs", "collab", "business", "notice"].includes(category) || !title || !content) return json({ error: "invalid_post" }, 400);
      if (category === "notice" && !isAdmin) return json({ error: "admin_only" }, 403);
      const identity = await boardIdentity(email, special, await myOverride());
      const { data, error } = await adminClient.from("hanjogo_board_posts").insert({
        author_id: userId, author_email: email, author_name: identity.name,
        author_generation: identity.generation, category, title, content, is_notice: category === "notice",
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "board_update") {
      const id = Number(body.id);
      const category = cleanBoardText(body.category, 20);
      const title = cleanBoardText(body.title, 120);
      const content = cleanBoardText(body.content, 5000);
      if (!Number.isFinite(id) || !["free", "jobs", "collab", "business", "notice"].includes(category) || !title || !content) return json({ error: "invalid_post" }, 400);
      if (category === "notice" && !isAdmin) return json({ error: "admin_only" }, 403);
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_board_posts").select("id,author_id").eq("id", id).eq("is_hidden", false).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target) return json({ error: "not_found" }, 404);
      if (!isAdmin && target.author_id !== userId) return json({ error: "forbidden" }, 403);
      const { error } = await adminClient.from("hanjogo_board_posts").update({ category, title, content, is_notice: category === "notice", updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "board_delete") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: "invalid_post" }, 400);
      const { data: target, error: lookupError } = await adminClient.from("hanjogo_board_posts").select("id,author_id").eq("id", id).eq("is_hidden", false).maybeSingle();
      if (lookupError) return json({ error: lookupError.message }, 500);
      if (!target) return json({ error: "not_found" }, 404);
      if (!isAdmin && target.author_id !== userId) return json({ error: "forbidden" }, 403);
      const { error } = await adminClient.from("hanjogo_board_posts").update({ is_hidden: true, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "board_comment_create") {
      const postId = Number(body.postId);
      const content = cleanBoardText(body.content, 1000);
      if (!Number.isFinite(postId) || !content) return json({ error: "invalid_comment" }, 400);
      const { data: post, error: postError } = await adminClient.from("hanjogo_board_posts").select("id").eq("id", postId).eq("is_hidden", false).maybeSingle();
      if (postError) return json({ error: postError.message }, 500);
      if (!post) return json({ error: "post_not_found" }, 404);
      const identity = await boardIdentity(email, special, await myOverride());
      const { error } = await adminClient.from("hanjogo_board_comments").insert({
        post_id: postId, author_id: userId, author_email: email, author_name: identity.name,
        author_generation: identity.generation, content,
      });
      if (error) return json({ error: error.message }, 500);
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
    if (approve) {
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
    return json({ ok: true });
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
