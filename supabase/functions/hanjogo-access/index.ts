import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALUMNI_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSuW1LbjftAqI7V9V65eehlY_KQ4JIRwLR80rfUdAQXoFGywIOs4tk1LAuRBJ17pEdAslBjpLaqqCY5/pub?output=csv";
const PROFILE_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQm2qyYr9BAEm-fyZvNyExxiPS9lcRBPi06n__Qq__WlRPvGF_Iou7x1lIjsmBgqpoqHo4M2syaFVxc/pub?gid=648141668&single=true&output=csv";
const ADMIN_EMAIL = "mainxoals@gmail.com";
const ALUMNI_EMAIL_CACHE_TTL = 5 * 60 * 1000;
let alumniEmailCache: { expiresAt: number; emails: Set<string> } | null = null;
let alumniEmailCachePromise: Promise<Set<string>> | null = null;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
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

function numberFromText(value: unknown) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

async function boardIdentity(email: string, special: Record<string, unknown> | null) {
  if (email === ADMIN_EMAIL) return { name: "김태민", generation: 2 };
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
      const name = cleanBoardText(nameKey ? row[nameKey] : "", 40);
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const adminClient = createClient(url, serviceKey);

  const { data: userData, error: userError } = await authClient.auth.getUser(jwt);
  const email = normalizeEmail(userData?.user?.email);
  const userId = String(userData?.user?.id || "");
  if (userError || !email) return json({ error: "unauthorized" }, 401);
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
      const allRows = rowsAsObjects(await fetchCsv(PROFILE_CSV_URL));
      const todayKey = koreaDateKey();
      const firstPublicDates = firstPublicProfileDates(allRows);
      const rows = latestProfileRowsByEmail(allRows);
      const profiles = (await Promise.all(
        rows.map((row) => buildProfile(row, contactOverrides, firstPublicDates, todayKey, email)),
      )).filter(Boolean);
      return json({ allowed: true, profiles, count: profiles.length });
    } catch {
      return json({ allowed: true, error: "profiles_unavailable" }, 503);
    }
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
      const identity = await boardIdentity(email, special);
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
      const identity = await boardIdentity(email, special);
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

  return json({ error: "unknown_action" }, 400);
});
