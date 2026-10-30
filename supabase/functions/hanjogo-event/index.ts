import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.117.0";
import { cleanSurveyAnswers, cleanSurveyQuestions, matchParticipants, summarizeByGeneration, summarizeSurvey, type SurveyQuestion } from "./event-survey.ts";

// 모임 결산·만족도 조사 전용 함수(hanjogo-access가 너무 커져 따로 둡니다). 참가자 판단은 hanjogo_event_participants 표로 합니다.
const ALUMNI_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSuW1LbjftAqI7V9V65eehlY_KQ4JIRwLR80rfUdAQXoFGywIOs4tk1LAuRBJ17pEdAslBjpLaqqCY5/pub?output=csv";
const ADMIN_EMAIL = "mainxoals@gmail.com";

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

function numberFromText(value: unknown) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function cleanBoardText(value: unknown, maxLength: number) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function validGeneration(value: unknown) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
}

function alumniName(value: unknown) {
  const text = String(value ?? "").trim();
  const korean = text.match(/^([가-힣]{2,5})(?![가-힣])/);
  return korean ? korean[1] : text;
}

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

/** 1·2차 참가 신청 응답(구글 폼 시트)의 이름·기수·이메일. 졸업생 DB에서 못 찾은 참가자를 한 번 더 찾는 데 씁니다. */
async function applicantPeople(urls: string[]) {
  const people: { name: string; generation: number; email: string }[] = [];
  for (const url of urls) {
    try {
      const rows = rowsAsObjects(await fetchCsv(url));
      rows.forEach((row) => {
        const nameKey = Object.keys(row).find((key) => /이름|성명/.test(key));
        const genKey = Object.keys(row).find((key) => /기수/.test(key));
        const emailKey = Object.keys(row).find((key) => /이메일|email/i.test(key));
        const person = {
          name: alumniName(nameKey ? row[nameKey] : ""),
          generation: numberFromText(genKey ? row[genKey] : ""),
          email: normalizeEmail(emailKey ? row[emailKey] : ""),
        };
        if (person.name && person.generation && person.email) people.push(person as { name: string; generation: number; email: string });
      });
    } catch { /* 시트를 못 읽으면 그 시트는 건너뜁니다. */ }
  }
  return people;
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
  if (claimsError || !email) return json({ error: "unauthorized" }, 401);
  const isAdmin = email === ADMIN_EMAIL;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const action = String(body.action || "");

  // ---- 모임 결산·만족도 조사 (참가자 전용) ------------------------------------
  // 참가자 판단은 로그인한 이메일이 hanjogo_event_participants에 있는지로 합니다.
  // 참가자가 아니면 상세 결산·설문 문항·자유 의견은 응답에 담지 않고, 간략 정보만 보냅니다.
  if (action.startsWith("event_")) {
    const eventKey = String(body.eventKey || "");
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(eventKey)) return json({ error: "invalid_event" }, 400);
    const { data: ev, error: evError } = await adminClient.from("hanjogo_event_info").select("*").eq("event_key", eventKey).maybeSingle();
    if (evError) return json({ error: evError.message }, 500);
    const questions = (cleanSurveyQuestions(ev?.survey_questions) || []) as SurveyQuestion[];
    const loadResponses = async () => {
      const { data, error } = await adminClient.from("hanjogo_event_survey_responses").select("answers,generation").eq("event_key", eventKey);
      if (error) throw error;
      return (data || []) as { answers: Record<string, unknown>; generation: number | null }[];
    };
    const isParticipant = async () => {
      if (isAdmin) return true;
      const { data, error } = await adminClient.from("hanjogo_event_participants").select("email").eq("event_key", eventKey).eq("email", email).maybeSingle();
      if (error) throw error;
      return Boolean(data);
    };
    try {
      // 관리자: 모임 안내·결산·설문 문항 저장
      if (action === "event_admin_save") {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        const title = String(body.title ?? ev?.title ?? "").trim().slice(0, 80);
        if (!title) return json({ error: "title_required" }, 400);
        const surveyQuestions = body.surveyQuestions === undefined ? (ev?.survey_questions ?? []) : cleanSurveyQuestions(body.surveyQuestions);
        if (surveyQuestions === null) return json({ error: "invalid_questions" }, 400);
        const asObject = (value: unknown, fallback: unknown) =>
          value === undefined ? fallback : (value && typeof value === "object" && !Array.isArray(value) ? value : null);
        const publicSummary = asObject(body.publicSummary, ev?.public_summary ?? {});
        const detail = asObject(body.detail, ev?.detail ?? {});
        if (publicSummary === null || detail === null) return json({ error: "invalid_body" }, 400);
        const eventDate = body.eventDate === undefined ? (ev?.event_date ?? null) : (String(body.eventDate || "") || null);
        if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate))) return json({ error: "invalid_date" }, 400);
        const { error } = await adminClient.from("hanjogo_event_info").upsert({
          event_key: eventKey, title, event_date: eventDate,
          published: body.published === undefined ? Boolean(ev?.published) : Boolean(body.published),
          public_summary: publicSummary, detail,
          survey_open: body.surveyOpen === undefined ? Boolean(ev?.survey_open) : Boolean(body.surveyOpen),
          survey_questions: surveyQuestions, updated_at: new Date().toISOString(),
        }, { onConflict: "event_key" });
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }

      // 관리자: 참가자 명단을 동문 DB 이메일과 맞추기(preview 미리보기 / apply 저장), 수동 추가·삭제
      if (action === "event_admin_participants") {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        if (!ev) return json({ error: "event_not_found" }, 404);
        const mode = String(body.mode || "preview");
        if (mode === "add") {
          const who = normalizeEmail(body.email);
          if (!who) return json({ error: "invalid_email" }, 400);
          const { error } = await adminClient.from("hanjogo_event_participants").upsert(
            { event_key: eventKey, email: who, name: cleanBoardText(body.name, 20) || null, generation: validGeneration(body.generation), source: "manual" },
            { onConflict: "event_key,email" },
          );
          if (error) return json({ error: error.message }, 500);
          return json({ ok: true });
        }
        if (mode === "remove") {
          const { error } = await adminClient.from("hanjogo_event_participants").delete().eq("event_key", eventKey).eq("email", normalizeEmail(body.email));
          if (error) return json({ error: error.message }, 500);
          return json({ ok: true });
        }
        // 최종 참가자 명단(hanjogo_event_roster)을 쓰고, 비어 있으면 내부 대시보드의 입금·참석 표(취소 제외)를 씁니다.
        const { data: rosterRows, error: rosterError } = await adminClient.from("hanjogo_event_roster").select("name,generation").eq("event_key", eventKey);
        if (rosterError) return json({ error: rosterError.message }, 500);
        let roster: { name: unknown; generation: unknown }[] = rosterRows || [];
        const { data: state, error: stateError } = await adminClient.from("dashboard_state").select("data").eq("id", "main").maybeSingle();
        if (stateError) return json({ error: stateError.message }, 500);
        if (!roster.length) {
          const payments = Array.isArray(state?.data?.participantPayments) ? state.data.participantPayments : [];
          roster = payments.filter((row: Record<string, unknown>) => String(row?.attendanceStatus || "") !== "cancelled");
        }
        const result = matchParticipants(roster, await alumniPeople());
        // 졸업생 DB에서 못 찾은 사람은 1·2차 참가 신청 응답에서 한 번 더 찾습니다(이름·기수가 같은 신청자의 이메일).
        let fromForms = 0;
        if (result.unmatched.length) {
          const csvUrls = ["participantApplySync", "secondParticipantApplySync", "participantFormSync"]
            .map((key) => String(state?.data?.[key]?.csvUrl || "")).filter((u) => /^https:\/\//.test(u));
          const again = matchParticipants(result.unmatched, await applicantPeople(csvUrls));
          const have = new Set(result.matched.map((p) => p.email));
          again.matched.forEach((p) => { if (!have.has(p.email)) { result.matched.push(p); have.add(p.email); fromForms += 1; } });
          result.unmatched = again.unmatched;
          result.ambiguous.push(...again.ambiguous);
        }
        if (mode === "apply") {
          const { data: existing, error: existingError } = await adminClient.from("hanjogo_event_participants").select("email,source").eq("event_key", eventKey);
          if (existingError) return json({ error: existingError.message }, 500);
          const manual = new Set((existing || []).filter((row) => row.source === "manual").map((row) => row.email));
          const rows = result.matched.filter((p) => !manual.has(p.email)).map((p) => ({ event_key: eventKey, email: p.email, name: p.name, generation: p.generation, source: "auto" }));
          if (rows.length) {
            const { error } = await adminClient.from("hanjogo_event_participants").upsert(rows, { onConflict: "event_key,email" });
            if (error) return json({ error: error.message }, 500);
          }
        }
        return json({ ok: true, mode, roster: roster.length, matched: result.matched.length, fromForms, ambiguous: result.ambiguous, unmatched: result.unmatched });
      }

      // 관리자: 설문 결과 전체(자유 의견 포함, 응답자는 알 수 없음)
      if (action === "event_admin_results") {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        const rows = await loadResponses();
        const comments = questions.filter((q) => q.type === "text").map((q) => ({ id: q.id, label: q.label, answers: rows.map((r) => r.answers?.[q.id]).filter((a) => typeof a === "string" && a) }));
        const { count } = await adminClient.from("hanjogo_event_participants").select("email", { count: "exact", head: true }).eq("event_key", eventKey);
        return json({ allowed: true, participants: count ?? 0, ...summarizeSurvey(questions, rows), byGeneration: summarizeByGeneration(questions, rows), comments });
      }

      if (!ev || (!ev.published && !isAdmin)) return json({ allowed: true, exists: false });
      const participant = await isParticipant();

      // 참가자: 설문 제출(한 사람 한 번, 다시 보내면 수정)
      if (action === "event_survey_submit") {
        if (!participant || isAdmin) return json({ error: "participants_only" }, 403);
        if (!ev.survey_open) return json({ error: "survey_closed" }, 409);
        const cleaned = cleanSurveyAnswers(questions, body.answers);
        if ("error" in cleaned) return json({ error: cleaned.error }, 400);
        const { data: mine, error: mineError } = await adminClient.from("hanjogo_event_participants").select("generation").eq("event_key", eventKey).eq("email", email).maybeSingle();
        if (mineError) return json({ error: mineError.message }, 500);
        const { error } = await adminClient.from("hanjogo_event_survey_responses").upsert(
          { event_key: eventKey, email, generation: mine?.generation ?? null, answers: cleaned.answers, updated_at: new Date().toISOString() },
          { onConflict: "event_key,email" },
        );
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }

      if (action === "event_state") {
        const rows = await loadResponses();
        const summary = summarizeSurvey(questions, rows);
        const enough = rows.length >= 5;
        const brief = {
          title: ev.title, eventDate: ev.event_date, summary: ev.public_summary,
          responseCount: enough ? rows.length : null, satisfaction: enough ? summary.overall : null,
          // 비참가자에게도 보여주는 결과 요약(자유 의견 제외, 응답 5건 이상일 때만)
          results: enough ? {
            responseCount: summary.responseCount, overall: summary.overall,
            ratings: summary.ratings.map((r) => ({ id: r.id, label: r.label, average: r.average })),
            choices: summary.choices.map((c) => ({ id: c.id, label: c.label, multi: c.multi, options: Object.entries(c.counts).map(([label, count]) => ({ label, count })) })),
          } : null,
        };
        if (!participant) return json({ allowed: true, exists: true, isParticipant: false, published: Boolean(ev.published), brief });
        let mine: Record<string, unknown> | null = null;
        if (!isAdmin) {
          const { data, error } = await adminClient.from("hanjogo_event_survey_responses").select("answers").eq("event_key", eventKey).eq("email", email).maybeSingle();
          if (error) throw error;
          mine = data?.answers ?? null;
        }
        return json({
          allowed: true, exists: true, isParticipant: true, isAdmin, published: Boolean(ev.published), brief, detail: ev.detail,
          survey: { open: Boolean(ev.survey_open), questions, mine },
          results: enough || isAdmin ? { responseCount: summary.responseCount, overall: summary.overall, ratings: summary.ratings, choices: summary.choices } : null,
        });
      }
    } catch (error) {
      return json({ error: String((error as { message?: string })?.message || error) }, 500);
    }
    return json({ error: "unknown_action" }, 400);
  }

  return json({ error: "unknown_action" }, 400);
});
