import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { InfoNote } from "@/components/ui/form-field";
import { accessCatalogQuery, accessLogQuery } from "@/lib/access/data";
import { effectiveDiff } from "@/lib/access/logic";
import type { AccessLogRow, Effective } from "@/lib/access/types";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAccessNames } from "@/hooks/use-access-names";

const ACTION_LABEL: Record<string, string> = {
  effective: "Права пересчитаны",
  assign: "Выдана роль",
  "assign.update": "Изменено назначение",
  unassign: "Снята роль",
  "personal.update": "Личные права",
  "role.create": "Новая роль",
  "role.update": "Изменена роль",
  "role.delete": "Удалена роль",
  "user.create": "Добавлен в портал",
  "user.update": "Изменены данные",
  "user.block": "Заблокирован",
  "user.unblock": "Разблокирован",
  "user.remove": "Убран из портала",
  "unit.create": "Новое подразделение",
  "unit.update": "Подразделение",
  "unit.delete": "Удалено подразделение",
  "member.set": "Состав подразделения",
  "position.save": "Должность",
  "position.delete": "Удалена должность",
  "brand.save": "Бренд",
  "brand.delete": "Удалён бренд",
  "studio.update": "Клуб",
  "studio.create": "Новый клуб",
  import: "Перенос «Доступов»",
};

export const LOG_ACTION_LABEL = ACTION_LABEL;

/**
 * Журнал изменений доступа: кто, когда, что. У строки «Права пересчитаны» —
 * что именно добавилось и что ушло (из итога прав до и после).
 */
export function AccessLogList({
  userId,
  limit = 200,
  compact,
  filter,
}: {
  userId: string | null;
  limit?: number;
  compact?: boolean;
  filter?: (row: AccessLogRow) => boolean;
}) {
  const { data, error, isLoading } = useQuery(accessLogQuery(userId, limit));
  const rows = (data ?? []).filter((r) => !filter || filter(r));
  if (error && !data) return <InfoNote variant="warning">{error.message}</InfoNote>;
  if (isLoading) return <p className="text-sm text-muted-foreground">Загружаем журнал…</p>;
  if (rows.length === 0) return <InfoNote variant="empty">Записей нет.</InfoNote>;
  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <LogRow key={r.id} row={r} compact={compact} />
      ))}
    </ul>
  );
}

function LogRow({ row, compact }: { row: AccessLogRow; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const names = useAccessNames(false);
  const { data: catalog } = useQuery(accessCatalogQuery);
  const diff =
    row.action === "effective"
      ? effectiveDiff(
          (row.details.before ?? null) as Effective | null,
          (row.details.after ?? null) as Effective | null,
          {
            studio: names.studio,
            kbBase: names.kbBase,
            perm: new Map((catalog ?? []).map((p) => [p.key, p.label])),
          },
        )
      : null;
  const changes = diff ? diff.added.length + diff.removed.length : 0;
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {formatDateTime(row.at)}
        </span>
        <span className="font-medium">{ACTION_LABEL[row.action] ?? row.action}</span>
        <span className="min-w-0">
          {row.summary !== ACTION_LABEL[row.action] ? row.summary : ""}
        </span>
        {!compact && row.target_user && row.action === "effective" && (
          <Link
            to="/access/users/$userId"
            params={{ userId: row.target_user }}
            className="text-brand-on-light hover:underline"
          >
            {row.target_name}
          </Link>
        )}
        <span className="text-xs text-muted-foreground">
          {row.actor_id ? `· ${row.actor_name}` : "· автоматически"}
        </span>
        {diff && changes > 0 && (
          <button
            type="button"
            className="text-xs text-brand-on-light hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Скрыть" : `Что изменилось (${changes})`}
          </button>
        )}
      </div>
      {open && diff && (
        <ul className="mt-1 space-y-0.5 rounded-md bg-muted/40 p-2 text-xs">
          {diff.added.map((t) => (
            <li key={`+${t}`} className={cn("text-emerald-700")}>
              + {t}
            </li>
          ))}
          {diff.removed.map((t) => (
            <li key={`-${t}`} className="text-rose-700">
              − {t}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
