import { type ReactNode, useState } from "react";

import { Card } from "@/components/ui/card";
import { useT } from "@/i18n";

/**
 * Занятия одного дня расписания (оба приложения). На сегодняшнем и будущих
 * днях прошедшие занятия свёрнуты в кнопку «Прошедшие тренировки» над
 * списком — открыв расписание, клиент сразу видит ближайшие; по нажатию
 * прошедшие раскрываются (приглушённые, как раньше). Прошлые дни — целиком,
 * как раньше.
 */
export function ScheduleDayList<E extends { id: string; starts_at: string }>({
  entries,
  pastDay,
  renderEntry,
}: {
  entries: E[];
  /** День раньше сегодняшнего — сворачивать нечего, всё прошло. */
  pastDay: boolean;
  renderEntry: (entry: E) => ReactNode;
}) {
  const t = useT();
  const [showPast, setShowPast] = useState(false);
  const now = Date.now();
  const isPast = (e: E) => new Date(e.starts_at).getTime() < now;
  const past = entries.filter(isPast);
  const upcoming = entries.filter((e) => !isPast(e));

  const row = (e: E) => (
    <div key={e.id} className={`relative pb-4 ${isPast(e) ? "opacity-20" : ""}`}>
      {renderEntry(e)}
    </div>
  );

  if (pastDay || past.length === 0) return <div className="relative">{entries.map(row)}</div>;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setShowPast((v) => !v)}
        aria-expanded={showPast}
        className="mb-4 flex h-10 w-full items-center justify-center rounded-lg bg-card text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
      >
        {showPast
          ? t("Скрыть прошедшие тренировки")
          : t("Прошедшие тренировки · {n}", { n: past.length })}
      </button>
      {showPast && past.map(row)}
      {upcoming.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {t("На сегодня тренировок больше нет")}
        </Card>
      ) : (
        upcoming.map(row)
      )}
    </div>
  );
}
