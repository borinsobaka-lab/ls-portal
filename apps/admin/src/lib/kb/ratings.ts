/**
 * Оценка статей базы знаний (db/migrations/2026-10-25_zzzzzz_kb_ratings_pager_color.sql):
 * три смайлика в конце статьи, ответ RPC kb_ratings_report — без React.
 */

export type KbScore = 1 | 2 | 3;

/** Смайлики слева направо: плохо, нормально, хорошо. Цвет — при наведении и у выбранного. */
export const KB_SCORES: {
  score: KbScore;
  key: "bad" | "ok" | "good";
  label: string;
  short: string;
  color: string;
  tone: "negative" | "warning" | "positive";
}[] = [
  { score: 1, key: "bad", label: "Не помогла", short: "Плохо", color: "#E5484D", tone: "negative" },
  { score: 2, key: "ok", label: "Так себе", short: "Нормально", color: "#F5B400", tone: "warning" },
  { score: 3, key: "good", label: "Помогла", short: "Хорошо", color: "#17B3A3", tone: "positive" },
];

export const kbScore = (score: number) => KB_SCORES.find((s) => s.score === score) ?? KB_SCORES[1];

export type KbRatingCounts = { count: number; bad: number; ok: number; good: number };

export type KbRatingsReport = {
  from: string | null;
  to: string;
  current: KbRatingCounts & { people: number };
  previous: KbRatingCounts & { people: number };
  articles: (KbRatingCounts & {
    id: string;
    title: string;
    parent_id: string | null;
    status: "draft" | "published" | "archived";
    feedback_enabled: boolean;
    last_at: string;
  })[];
  log: {
    id: number;
    node_id: string;
    title: string;
    user_id: string;
    full_name: string | null;
    avatar_url: string | null;
    score: KbScore;
    created_at: string;
    rated_at: string;
    /** Оценивал прежнюю версию статьи. */
    outdated: boolean;
  }[];
};

/** Счётчики по строкам оценок (у статьи в шапке — из своих строк kb_ratings). */
export function countScores(scores: number[]): KbRatingCounts {
  return {
    count: scores.length,
    bad: scores.filter((s) => s === 1).length,
    ok: scores.filter((s) => s === 2).length,
    good: scores.filter((s) => s === 3).length,
  };
}

/**
 * Средняя оценка от 0 до 100: «хорошо» — 100, «нормально» — 50, «плохо» — 0.
 * Без оценок — null.
 */
export function ratingIndex(c: KbRatingCounts): number | null {
  if (c.count === 0) return null;
  return Math.round(((c.good + c.ok * 0.5) / c.count) * 100);
}
