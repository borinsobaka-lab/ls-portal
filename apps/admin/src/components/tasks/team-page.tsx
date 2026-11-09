/**
 * «Подчинённые» (TASKS_CHATS_PLAN.md, 4.11; UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 4.10): руководителю и заместителю — люди его подразделений и ниже: задач в
 * работе, просрочено, на проверке, закрыто за неделю. Строка — задачи
 * человека (`/tasks?team=1&assignee=…`), «Поставить задачу» — ему сразу.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { TableSkeletonRows } from "@/components/skeletons";
import { PersonLine } from "@/components/tasks/task-bits";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePeople } from "@/lib/chats/people";
import { subordinatesQuery } from "@/lib/tasks/data";
import { cn } from "@/lib/utils";

export function TeamPage() {
  const navigate = useNavigate();
  const { name } = usePeople();
  const { data = [], isPending } = useQuery(subordinatesQuery);
  const [assignTo, setAssignTo] = useState<string | null>(null);
  const rows = [...data].sort(
    (a, b) =>
      b.overdue_count - a.overdue_count || name(a.user_id).localeCompare(name(b.user_id), "ru"),
  );
  return (
    <AdminShell title="Подчинённые">
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Сотрудник</TableHead>
              <TableHead className="w-32 text-right">В работе</TableHead>
              <TableHead className="w-32 text-right">Просрочено</TableHead>
              <TableHead className="w-32 text-right">На проверке</TableHead>
              <TableHead className="w-40 text-right">Закрыто за неделю</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableSkeletonRows rows={6} columns={5} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  Здесь — люди подразделений, где вы руководитель или заместитель (оргструктура в
                  «Компании»).
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.user_id}
                  className="group cursor-pointer"
                  title="Открыть задачи сотрудника"
                  onClick={() =>
                    void navigate({ to: "/tasks", search: { team: true, assignee: r.user_id } })
                  }
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <PersonLine id={r.user_id} className="min-w-0 flex-1" />
                      <Button
                        variant="outline"
                        size="xs"
                        className="shrink-0"
                        title={`Поставить задачу: ${name(r.user_id)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setAssignTo(r.user_id);
                        }}
                      >
                        <Plus /> Поставить задачу
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.open_count}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      r.overdue_count > 0 && "font-semibold text-destructive",
                    )}
                  >
                    {r.overdue_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.review_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.done_week}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <NewTaskDialog
        key={assignTo ?? "none"}
        open={!!assignTo}
        initialAssignee={assignTo ?? undefined}
        onClose={() => setAssignTo(null)}
      />
    </AdminShell>
  );
}
