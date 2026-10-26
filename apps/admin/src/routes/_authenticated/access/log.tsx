import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { AccessLogList, LOG_ACTION_LABEL } from "@/components/access/log-list";
import { AccessLogPageSkeleton } from "@/components/page-skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/access/log")({
  head: () => ({ meta: [{ title: "Журнал доступа — Lady Stretch" }] }),
  pendingComponent: AccessLogPageSkeleton,
  component: AccessLogPage,
});

const ALL = "all";
const GROUPS: Record<string, { label: string; actions: string[] }> = {
  roles: { label: "Роли", actions: ["role.create", "role.update", "role.delete"] },
  assign: {
    label: "Назначения и личные права",
    actions: ["assign", "assign.update", "unassign", "personal.update"],
  },
  users: {
    label: "Люди",
    actions: ["user.create", "user.update", "user.block", "user.unblock", "user.remove"],
  },
  structure: {
    label: "Структура и сеть",
    actions: [
      "unit.create",
      "unit.update",
      "unit.delete",
      "member.set",
      "position.save",
      "position.delete",
      "brand.save",
      "brand.delete",
      "studio.update",
      "studio.create",
    ],
  },
  effective: { label: "Пересчёт прав", actions: ["effective", "import"] },
};

/**
 * Журнал изменений доступа (ACCESS.md): кто, когда и что менял в ролях,
 * людях и структуре, и как от этого изменились права. Хранится всегда.
 */
function AccessLogPage() {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(ALL);
  const term = q.trim().toLowerCase();
  return (
    <AdminShell title="Журнал доступа">
      <div className="space-y-3">
        <TableToolbar>
          <ToolbarSearch value={q} onChange={setQ} placeholder="Кто, кому, что" />
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger aria-label="Что" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все изменения</SelectItem>
              {Object.entries(GROUPS).map(([key, g]) => (
                <SelectItem key={key} value={key}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToolbarReset
            active={!!q || group !== ALL}
            onReset={() => {
              setQ("");
              setGroup(ALL);
            }}
          />
        </TableToolbar>
        <div className="rounded-lg border bg-background px-4 py-2">
          <AccessLogList
            userId={null}
            limit={1000}
            filter={(r) =>
              (group === ALL || GROUPS[group].actions.includes(r.action)) &&
              (!term ||
                `${r.summary ?? ""} ${r.actor_name ?? ""} ${r.target_name ?? ""} ${LOG_ACTION_LABEL[r.action] ?? ""}`
                  .toLowerCase()
                  .includes(term))
            }
          />
        </div>
      </div>
    </AdminShell>
  );
}
