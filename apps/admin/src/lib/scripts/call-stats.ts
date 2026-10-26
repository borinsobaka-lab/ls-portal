/**
 * Статистика звонков: из сырых счётчиков RPC scripts_call_stats — воронка по
 * этапам сценария и места окончания; для истории — докуда дошёл один звонок.
 * Перенос подсчёта из «Аудиоаналитики» (backend/app/routers/playbook_calls.py).
 */
import type { CallNode, CallRunRow, CallStatsRaw } from "./types";

/** Не завершённый звонок, который трогали меньше получаса назад, ещё идёт. */
export const LIVE_WINDOW_MS = 30 * 60 * 1000;

type NodeLike = Pick<CallNode, "id" | "title" | "group"> & { answers?: CallNode["answers"] };

export type FunnelStep = { node_id: string; title: string; reached: number; ended_here: number };
export type EndStat = {
  node_id: string;
  title: string;
  group: string;
  script_end: boolean;
  count: number;
};

export type CallStats = {
  sections: CallStatsRaw["sections"];
  section_id: string | null;
  users: { user_id: string; name: string; runs: number }[];
  totals: { runs: number; completed: number; avg_steps: number | null };
  funnel: FunnelStep[];
  ends: EndStat[];
};

/**
 * Конец сценария — блок без ответов. У этапов, восстановленных по звонкам
 * удалённого сценария, ответов не знаем — концом не считаем.
 */
export function scriptEnds(nodes: NodeLike[]): Set<string> {
  return new Set(nodes.filter((n) => n.answers && n.answers.length === 0).map((n) => n.id));
}

/**
 * Блоки сценария по порядку. Сценарий удалён — этапы восстанавливаются по
 * самим звонкам, в порядке первого появления.
 */
export function flowNodes(
  live: CallNode[] | null | undefined,
  seen: CallStatsRaw["seen"],
): NodeLike[] {
  if (live?.length) return live;
  return (seen ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    group: s.group === "objection" ? "objection" : "main",
  }));
}

export function buildCallStats(
  raw: CallStatsRaw,
  liveNodes: CallNode[] | null | undefined,
): CallStats {
  const nodes = flowNodes(liveNodes, raw.seen);
  const ends = scriptEnds(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reached = raw.reached ?? {};
  const endedRaw = raw.ended ?? [];
  const endedCount = new Map(endedRaw.map((e) => [e.node_id, e.count]));
  return {
    sections: raw.sections,
    section_id: raw.section_id,
    users: raw.users ?? [],
    totals: {
      runs: raw.runs ?? 0,
      completed: endedRaw.filter((e) => ends.has(e.node_id)).reduce((n, e) => n + e.count, 0),
      avg_steps: raw.avg_steps == null ? null : Number(raw.avg_steps),
    },
    funnel: nodes
      .filter((n) => n.group === "main")
      .map((n) => ({
        node_id: n.id,
        title: n.title,
        reached: reached[n.id] ?? 0,
        ended_here: endedCount.get(n.id) ?? 0,
      })),
    ends: endedRaw.map((e) => {
      const node = byId.get(e.node_id);
      return {
        node_id: e.node_id,
        title: node?.title || e.title || e.node_id,
        group: node?.group ?? e.group ?? "main",
        script_end: ends.has(e.node_id),
        count: e.count,
      };
    }),
  };
}

export type RunProgress = {
  /** Самый дальний этап сценария по порядку (1…stages), 0 — ни одного. */
  reached: number;
  stages: number;
  reached_title: string;
  last_title: string;
  last_group: string;
  script_end: boolean;
  live: boolean;
  steps: number;
  /** От первого шага до последнего, по часам админки; null — не посчитать. */
  seconds: number | null;
};

export function runProgress(
  run: CallRunRow,
  nodes: NodeLike[],
  now: number = Date.now(),
): RunProgress {
  const path = run.path ?? [];
  const stages = nodes.filter((n) => n.group === "main");
  const ids = new Set(path.map((s) => s.id));
  let reached = 0;
  stages.forEach((n, i) => {
    if (ids.has(n.id)) reached = i + 1;
  });
  const last = path[path.length - 1];
  const titles = new Map(nodes.map((n) => [n.id, n.title]));
  let seconds: number | null = null;
  if (path.length > 1) {
    const a = Date.parse(path[0].at);
    const b = Date.parse(last.at);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) seconds = (b - a) / 1000;
  }
  return {
    reached,
    stages: stages.length,
    reached_title: reached ? stages[reached - 1].title : "",
    last_title: (last && (titles.get(last.id) || last.title)) || "",
    last_group: last?.group ?? "main",
    script_end: !!last && scriptEnds(nodes).has(last.id),
    live: !run.ended_at && now - Date.parse(run.updated_at) < LIVE_WINDOW_MS,
    steps: path.length,
    seconds,
  };
}

/** Доля в процентах: «42%», мелкие — с десятой, «—» без базы. */
export function pct(part: number, whole: number): string {
  if (!whole) return "—";
  const v = (part / whole) * 100;
  return `${v < 10 && v > 0 ? v.toFixed(1).replace(".", ",") : Math.round(v)}%`;
}

/** Длительность: «2 мин 15 с», «40 с». */
export function duration(seconds: number | null): string {
  if (seconds == null || seconds < 1) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} с`;
  const rest = s % 60;
  return rest ? `${Math.floor(s / 60)} мин ${rest} с` : `${Math.floor(s / 60)} мин`;
}
