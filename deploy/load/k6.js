// Нагрузочный прогон портала (k6, https://k6.io): виртуальные сотрудники
// читают статьи базы знаний, ищут и проходят тест в Академии — те же
// запросы к API Supabase, что делает портал в браузере.
//
// Перед прогоном — deploy/load/seed.sql (500 тестовых сотрудников, база и
// курс «Нагрузочный тест»), после — deploy/load/cleanup.sql.
//
// Запуск на сервере (секрет JWT не покидает его):
//   docker run --rm -i --network host -v "$PWD/deploy/load:/load" grafana/k6 run \
//     -e SUPABASE_URL=https://api.example.ru -e ANON_KEY=eyJ... \
//     -e JWT_SECRET=... /load/k6.js
// Необязательно: -e VUS=500 (пик), -e HOLD=10m (сколько держать пик),
// -e USERS=500 (сколько сотрудников в seed.sql).
//
// Токены сотрудников k6 подписывает секретом JWT Supabase (как GoTrue после
// входа по коду): входить 500 раз по почте не нужно.
import http from "k6/http";
import crypto from "k6/crypto";
import encoding from "k6/encoding";
import { check, group, sleep } from "k6";
import { Trend } from "k6/metrics";

const URL = (__ENV.SUPABASE_URL || "").replace(/\/+$/, "");
// Путь PostgREST за шлюзом Supabase; для прямого PostgREST — REST_PATH="".
const REST = URL + (__ENV.REST_PATH ?? "/rest/v1");
const ANON = __ENV.ANON_KEY || "";
const SECRET = __ENV.JWT_SECRET || "";
const VUS = Number(__ENV.VUS || 500);
const USERS = Number(__ENV.USERS || 500);
const HOLD = __ENV.HOLD || "10m";

const articleOpen = new Trend("article_open_ms", true);
const searchTime = new Trend("search_ms", true);
const quizTime = new Trend("quiz_submit_ms", true);

export const options = {
  scenarios: {
    staff: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: Math.round(VUS / 5) }, // начало смены
        { duration: "3m", target: VUS },
        { duration: HOLD, target: VUS },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
    article_open_ms: ["p(95)<1500"],
    search_ms: ["p(95)<1000"],
  },
};

// --- Токены ----------------------------------------------------------------
const b64url = (s) => encoding.b64encode(s, "rawurl");

function userId(n) {
  // md5('ls-loadtest-' || n)::uuid — как в seed.sql.
  const h = crypto.md5(`ls-loadtest-${n}`, "hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function token(sub, email) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      sub,
      email,
      role: "authenticated",
      aud: "authenticated",
      iss: `${URL}/auth/v1`,
      iat: now,
      exp: now + 6 * 3600,
    }),
  );
  const sig = crypto.hmac("sha256", SECRET, `${head}.${body}`, "binary");
  return `${head}.${body}.${encoding.b64encode(sig, "rawurl")}`;
}

// --- Запросы ---------------------------------------------------------------
function headers(jwt) {
  return {
    apikey: ANON,
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
    "Accept-Profile": "public",
    "Content-Profile": "public",
  };
}

function get(jwt, path, name) {
  const res = http.get(`${REST}/${path}`, { headers: headers(jwt), tags: { name } });
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
  return res;
}

function rpc(jwt, fn, args, name = fn) {
  const res = http.post(`${REST}/rpc/${fn}`, JSON.stringify(args || {}), {
    headers: headers(jwt),
    tags: { name },
  });
  check(res, { [`${name} ok`]: (r) => r.status === 200 || r.status === 204 });
  return res;
}

const json = (res) => {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const TREE =
  "id,base_id,parent_id,kind,title,description,icon,protect,feedback_enabled,pager_enabled,sort_order,status,reader_visible,created_at,updated_at,published_at,published_by";
const WORDS = ["касса", "клиент", "абонемент", "запись", "тренер", "возврат", "заморозка", "смена"];

export function setup() {
  if (!URL || !ANON || !SECRET) throw new Error("Задайте SUPABASE_URL, ANON_KEY и JWT_SECRET");
  const jwt = token(userId(1), "loadtest-001@loadtest.invalid");
  const bases = json(get(jwt, `kb_bases?select=id,title&title=eq.${encodeURIComponent("Нагрузочный тест")}`, "kb_bases")) || [];
  if (!bases.length) throw new Error("Нет базы «Нагрузочный тест» — выполните seed.sql");
  return { baseId: bases[0].id };
}

// --- Сценарий: один «визит» сотрудника --------------------------------------
export default function (data) {
  const n = ((__VU - 1) % USERS) + 1;
  const sub = userId(n);
  const jwt = token(sub, `loadtest-${String(n).padStart(3, "0")}@loadtest.invalid`);
  const base = data.baseId;

  // Портал открылся: базы, доступы, дерево базы, Академия в рейке.
  let tree = [];
  group("вход в базу знаний", () => {
    get(jwt, "kb_bases?select=id,title,rail_title,icon,description,sort_order,protect_content,brand_color&order=sort_order,created_at", "kb_bases");
    get(jwt, `kb_grants?select=base_id,level&subject_type=eq.user&subject_id=eq.${sub}&node_id=is.null`, "kb_grants");
    tree = json(get(jwt, `kb_nodes?select=${TREE}&base_id=eq.${base}&order=sort_order,created_at`, "kb_tree")) || [];
    get(jwt, `kb_tags?select=id,name,color&base_id=eq.${base}`, "kb_tags");
    get(jwt, `kb_node_tags?select=node_id,tag_id&base_id=eq.${base}`, "kb_node_tags");
    rpc(jwt, "acad_access");
  });
  const articles = tree.filter((x) => x.kind === "article");
  if (!articles.length) return;
  sleep(2 + Math.random() * 3);

  const roll = Math.random();
  if (roll < 0.7) {
    // Чтение 1–3 статей: открыть, читать (учёт раз в 30 с), дальше.
    const count = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const node = pick(articles);
      group("статья", () => {
        const t0 = Date.now();
        get(jwt, `kb_nodes?select=${TREE},content&id=eq.${node.id}`, "kb_node");
        get(jwt, `kb_favorites?select=node_id,created_at&base_id=eq.${base}&order=created_at.desc`, "kb_favorites");
        get(jwt, `kb_reads?select=node_id,last_read_at&base_id=eq.${base}&user_id=eq.${sub}&order=last_read_at.desc&limit=12`, "kb_reads");
        get(jwt, `kb_checks?select=block_id&node_id=eq.${node.id}`, "kb_checks");
        rpc(jwt, "kb_authors", { p_base: base });
        rpc(jwt, "kb_mark_read", { p_node: node.id });
        articleOpen.add(Date.now() - t0);
      });
      const reads = 1 + Math.floor(Math.random() * 3);
      for (let r = 0; r < reads; r++) {
        sleep(25 + Math.random() * 10);
        rpc(jwt, "kb_track_reading", { p_node: node.id, p_seconds: 30, p_scroll: Math.round((100 * (r + 1)) / reads) });
      }
    }
  } else if (roll < 0.9) {
    // Поиск: набор по буквам (2–3 запроса), переход к найденному.
    group("поиск", () => {
      const word = pick(WORDS);
      let hits = [];
      for (const len of [3, 5, word.length]) {
        const q = word.slice(0, len);
        const t0 = Date.now();
        hits = json(rpc(jwt, "kb_search", { p_query: q, p_base: base, p_folder: null, p_limit: 30 })) || [];
        searchTime.add(Date.now() - t0);
        sleep(0.4 + Math.random() * 0.4);
      }
      const logged = json(rpc(jwt, "kb_log_search", { p_base: base, p_query: word, p_results: hits.length, p_in_folder: false }));
      if (hits.length) {
        if (logged) rpc(jwt, "kb_log_search_click", { p_id: logged, p_node: hits[0].id });
        get(jwt, `kb_nodes?select=${TREE},content&id=eq.${hits[0].id}`, "kb_node");
        rpc(jwt, "kb_mark_read", { p_node: hits[0].id });
      }
    });
    sleep(20 + Math.random() * 20);
  } else {
    // Академия: мои курсы → курс → урок → тест → ответы.
    group("академия", () => {
      const courses = json(rpc(jwt, "acad_my_courses")) || [];
      const course = courses.find((c) => c.title === "Нагрузочный тест") || courses[0];
      if (!course) return;
      const courseId = course.course_id;
      const view = json(rpc(jwt, "acad_course_view", { p_course: courseId }));
      const steps = (view && view.steps) || [];
      const lesson = steps.find((s) => s.kind === "lesson");
      const quiz = steps.find((s) => s.kind === "quiz");
      if (lesson) {
        rpc(jwt, "acad_lesson", { p_step: lesson.id });
        sleep(15 + Math.random() * 15);
        rpc(jwt, "acad_lesson_complete", { p_step: lesson.id });
      }
      if (quiz) {
        const started = json(rpc(jwt, "acad_quiz_start", { p_step: quiz.id }));
        const questions = (started && started.questions) || [];
        sleep(10 + Math.random() * 20);
        const answers = questions.map((q) => ({
          question_id: q.id,
          options: [pick((q.options || []).map((o) => o.id))],
        }));
        const t0 = Date.now();
        rpc(jwt, "acad_quiz_submit", { p_step: quiz.id, p_answers: answers });
        quizTime.add(Date.now() - t0);
      }
    });
    sleep(10 + Math.random() * 10);
  }
}
