import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALUMNI_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSuW1LbjftAqI7V9V65eehlY_KQ4JIRwLR80rfUdAQXoFGywIOs4tk1LAuRBJ17pEdAslBjpLaqqCY5/pub?output=csv";
const PROFILE_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQm2qyYr9BAEm-fyZvNyExxiPS9lcRBPi06n__Qq__WlRPvGF_Iou7x1lIjsmBgqpoqHo4M2syaFVxc/pub?gid=648141668&single=true&output=csv";
const ADMIN_EMAIL = "mainxoals@gmail.com";

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

function getField(row: Record<string, string>, label: string) {
  const key = Object.keys(row).find((candidate) => normalizeKey(candidate) === normalizeKey(label));
  return key ? row[key] : "";
}

async function alumniEmailExists(email: string) {
  const rows = await fetchCsv(ALUMNI_CSV_URL);
  if (!rows.length) return false;
  const headers = rows[0].map((value) => value.trim().toLowerCase());
  const emailIndex = headers.findIndex((header) => header.includes("이메일") || header === "email" || header.includes("email address"));
  if (emailIndex < 0) throw new Error("alumni_email_column_missing");
  return rows.slice(1).some((row) => normalizeEmail(row[emailIndex]) === email);
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

function buildProfile(row: Record<string, string>) {
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
  const allowEmailContact = contactConsent.includes("허용합니다");
  const attendeePreference = getField(row, "행사 참가자 명단에 표시해도 될까요?");
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
  if (userError || !email) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const action = String(body.action || "verify");

  const { data: special } = await adminClient
    .from("hanjogo_special_access")
    .select("id,email,name,note")
    .eq("email", email)
    .maybeSingle();

  let inAlumniDb = false;
  try {
    inAlumniDb = Boolean(special) || await alumniEmailExists(email);
  } catch {
    return json({ allowed: false, error: "access_check_unavailable" }, 503);
  }

  if (action === "verify") {
    return json({ allowed: inAlumniDb, source: special ? "special" : inAlumniDb ? "alumni_db" : null });
  }

  if (action === "profiles") {
    if (!inAlumniDb) return json({ allowed: false, error: "not_alumni" }, 403);
    try {
      const rows = latestProfileRowsByEmail(rowsAsObjects(await fetchCsv(PROFILE_CSV_URL)));
      const profiles = rows.map(buildProfile).filter(Boolean);
      return json({ allowed: true, profiles, count: profiles.length });
    } catch {
      return json({ allowed: true, error: "profiles_unavailable" }, 503);
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
