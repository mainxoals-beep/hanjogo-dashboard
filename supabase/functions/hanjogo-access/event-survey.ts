// 모임 결산·만족도 조사의 순수 계산 함수 모음(네트워크·DB 없이 시험할 수 있게 따로 둡니다).

export type SurveyQuestion = {
  id: string;
  label: string;
  type: "rating" | "choice" | "text";
  required: boolean;
  options?: string[];
};

const QUESTION_ID = /^[a-z0-9_]{1,24}$/;

/** 관리자가 보낸 문항 목록을 검사해 깨끗한 값으로 돌려줍니다. 문제가 있으면 null. */
export function cleanSurveyQuestions(value: unknown): SurveyQuestion[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const seen = new Set<string>();
  const result: SurveyQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const id = String(item.id ?? "");
    const label = String(item.label ?? "").trim();
    const type = String(item.type ?? "");
    if (!QUESTION_ID.test(id) || seen.has(id) || !label || label.length > 120) return null;
    if (type !== "rating" && type !== "choice" && type !== "text") return null;
    seen.add(id);
    const question: SurveyQuestion = { id, label, type, required: Boolean(item.required) };
    if (type === "choice") {
      const options = Array.isArray(item.options) ? item.options.map((o) => String(o ?? "").trim()) : [];
      if (options.length < 2 || options.length > 10 || options.some((o) => !o || o.length > 40) || new Set(options).size !== options.length) return null;
      question.options = options;
    }
    result.push(question);
  }
  return result;
}

/** 참가자가 보낸 답을 문항에 맞춰 검사합니다. 문항에 없는 키는 버립니다. */
export function cleanSurveyAnswers(
  questions: SurveyQuestion[],
  value: unknown,
): { answers: Record<string, string | number> } | { error: string } {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const answers: Record<string, string | number> = {};
  for (const question of questions) {
    const raw = input[question.id];
    const empty = raw === undefined || raw === null || String(raw).trim() === "";
    if (empty) {
      if (question.required) return { error: "answer_required:" + question.id };
      continue;
    }
    if (question.type === "rating") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) return { error: "invalid_answer:" + question.id };
      answers[question.id] = n;
    } else if (question.type === "choice") {
      const text = String(raw);
      if (!question.options?.includes(text)) return { error: "invalid_answer:" + question.id };
      answers[question.id] = text;
    } else {
      const text = String(raw).trim().slice(0, 1000);
      if (text) answers[question.id] = text;
    }
  }
  return { answers };
}

/** 응답을 문항별 평균·선택 수로 모읍니다. 누가 답했는지는 담지 않습니다. */
export function summarizeSurvey(questions: SurveyQuestion[], rows: { answers: Record<string, unknown> }[]) {
  const ratings = questions.filter((q) => q.type === "rating").map((q) => {
    const values = rows.map((r) => Number(r.answers?.[q.id])).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
    return { id: q.id, label: q.label, count: values.length, average: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null };
  });
  const choices = questions.filter((q) => q.type === "choice").map((q) => {
    const counts: Record<string, number> = Object.fromEntries((q.options || []).map((o) => [o, 0]));
    rows.forEach((r) => { const a = r.answers?.[q.id]; if (typeof a === "string" && a in counts) counts[a] += 1; });
    return { id: q.id, label: q.label, counts };
  });
  const rated = questions.filter((q) => q.type === "rating");
  const every = rows.flatMap((row) => rated.map((q) => Number(row.answers?.[q.id])).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5));
  return {
    responseCount: rows.length,
    overall: every.length ? Math.round(every.reduce((a, b) => a + b, 0) / every.length * 10) / 10 : null,
    ratings,
    choices,
  };
}

export type AlumniPerson = { name: string; generation: number; email: string };

function personName(value: unknown) {
  const text = String(value ?? "").trim();
  const korean = text.match(/^([가-힣]{2,5})(?![가-힣])/);
  return korean ? korean[1] : text;
}
function personGeneration(value: unknown) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

/**
 * 참가자 명단(이름·기수)을 동문 DB(이름·기수·이메일)와 맞춥니다.
 * 이름+기수에 이메일이 딱 하나면 맞춤, 여럿이면 애매함, 없으면 못 찾음입니다.
 */
export function matchParticipants(rows: { name: unknown; generation: unknown }[], people: AlumniPerson[]) {
  const byKey = new Map<string, Set<string>>();
  people.forEach((p) => {
    const key = p.name + "|" + p.generation;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(p.email);
  });
  const matched: AlumniPerson[] = [];
  const ambiguous: { name: string; generation: number; count: number }[] = [];
  const unmatched: { name: string; generation: number | null }[] = [];
  const seenEmail = new Set<string>();
  const seenRow = new Set<string>();
  rows.forEach((row) => {
    const name = personName(row.name);
    const generation = personGeneration(row.generation);
    if (!name) return;
    const rowKey = name + "|" + generation;
    if (seenRow.has(rowKey)) return;
    seenRow.add(rowKey);
    const emails = generation ? byKey.get(rowKey) : undefined;
    if (!emails || !emails.size) { unmatched.push({ name, generation }); return; }
    if (emails.size > 1) { ambiguous.push({ name, generation: generation!, count: emails.size }); return; }
    const email = [...emails][0];
    if (seenEmail.has(email)) return;
    seenEmail.add(email);
    matched.push({ name, generation: generation!, email });
  });
  return { matched, ambiguous, unmatched };
}
