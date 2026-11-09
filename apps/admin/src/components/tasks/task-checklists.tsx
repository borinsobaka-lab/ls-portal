/**
 * Чек-листы задачи (план, 4.6, боль № 9): несколько списков, у пункта —
 * свой исполнитель (не в задаче — станет соисполнителем), кто и когда
 * отметил. Правят постановщик, исполнитель, соисполнители; отмечает и
 * исполнитель пункта. У названия — карандаш, под ним — полоса готовности; у
 * пункта — «⋯» (изменить, удалить) и исполнитель; на сенсорном экране всё
 * видно сразу (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 4.11).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { PeoplePicker } from "@/components/chats/dialogs";
import { useConfirm } from "@/components/confirm-dialog";
import { PersonLine } from "@/components/tasks/task-bits";
import { TaskMenu } from "@/components/tasks/task-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePeople } from "@/lib/chats/people";
import { formatDateTime } from "@/lib/format";
import { taskAction, taskErrorText } from "@/lib/tasks/data";
import type { Checklist, ChecklistItem, TaskFull } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

export function TaskChecklists({
  task,
  canWork,
  me,
}: {
  task: TaskFull;
  canWork: boolean;
  me: string;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const call = async (fn: string, args: Record<string, unknown>) => {
    try {
      await taskAction(qc, fn, args);
      return true;
    } catch (e) {
      toast.error(taskErrorText(e));
      return false;
    }
  };

  if (!task.checklists.length && !canWork) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <ListChecks className="size-4 text-muted-foreground" /> Чек-листы
          {task.check_total > 0 && (
            <span className="text-sm font-normal text-muted-foreground">
              {task.check_done} из {task.check_total}
            </span>
          )}
        </h3>
        {canWork && !adding && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Новый чек-лист
          </Button>
        )}
      </div>
      {task.checklists.map((l) => (
        <ChecklistBlock key={l.id} list={l} canWork={canWork} me={me} call={call} />
      ))}
      {adding && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            if (
              await call("task_checklist_save", {
                p_task: task.id,
                p_id: null,
                p_title: title.trim(),
              })
            ) {
              setTitle("");
              setAdding(false);
            }
          }}
        >
          <Input
            autoFocus
            value={title}
            placeholder="Название чек-листа"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
          />
          <Button type="submit">Создать</Button>
        </form>
      )}
    </section>
  );
}

function ChecklistBlock({
  list,
  canWork,
  me,
  call,
}: {
  list: Checklist;
  canWork: boolean;
  me: string;
  call: (fn: string, args: Record<string, unknown>) => Promise<boolean>;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [text, setText] = useState("");
  const [rename, setRename] = useState<string | null>(null);
  const done = list.items.filter((i) => i.done_at).length;
  const share = list.items.length ? done / list.items.length : 0;
  return (
    <div className="rounded-lg border bg-background">
      <div className="border-b px-3 py-2">
        <div className="flex items-center gap-2">
          {rename !== null ? (
            <Input
              autoFocus
              value={rename}
              aria-label="Название чек-листа"
              onChange={(e) => setRename(e.target.value)}
              onBlur={async () => {
                if (rename.trim() && rename.trim() !== list.title)
                  await call("task_checklist_save", {
                    p_task: null,
                    p_id: list.id,
                    p_title: rename.trim(),
                  });
                setRename(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRename(null);
              }}
            />
          ) : (
            <>
              <span className="min-w-0 truncate text-sm font-medium">{list.title}</span>
              {canWork && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={`Переименовать чек-лист «${list.title}»`}
                  title="Переименовать"
                  onClick={() => setRename(list.title)}
                >
                  <Pencil />
                </Button>
              )}
            </>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {done} из {list.items.length}
          </span>
          {canWork && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Удалить чек-лист «${list.title}»`}
              title="Удалить чек-лист"
              onClick={async () => {
                const ok = await confirm({
                  title: `Удалить чек-лист «${list.title}»?`,
                  description: "Пункты пропадут вместе с ним.",
                  confirmLabel: "Удалить",
                });
                if (ok) await call("task_checklist_delete", { p_id: list.id });
              }}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        {list.items.length > 0 && (
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Готово"
            aria-valuemin={0}
            aria-valuemax={list.items.length}
            aria-valuenow={done}
          >
            <div
              className="h-full rounded-full bg-emerald-600 transition-[width]"
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </div>
        )}
      </div>
      <ul className="divide-y">
        {list.items.map((i) => (
          <Item key={i.id} item={i} listId={list.id} canWork={canWork} me={me} call={call} />
        ))}
      </ul>
      {canWork && (
        <form
          className="px-3 py-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            if (
              await call("task_check_item_save", {
                p_checklist: list.id,
                p_id: null,
                p_text: text.trim(),
                p_assignee: null,
              })
            )
              setText("");
          }}
        >
          <Input
            className="border-dashed"
            value={text}
            placeholder="Новый пункт — Enter"
            onChange={(e) => setText(e.target.value)}
          />
        </form>
      )}
      {confirmDialog}
    </div>
  );
}

function Item({
  item,
  listId,
  canWork,
  me,
  call,
}: {
  item: ChecklistItem;
  listId: string;
  canWork: boolean;
  me: string;
  call: (fn: string, args: Record<string, unknown>) => Promise<boolean>;
}) {
  const { name } = usePeople();
  const { confirm, confirmDialog } = useConfirm();
  const [edit, setEdit] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const canToggle = canWork || item.assignee_id === me;
  const save = (text: string, assignee: string | null) =>
    call("task_check_item_save", {
      p_checklist: listId,
      p_id: item.id,
      p_text: text,
      p_assignee: assignee,
    });
  return (
    <li className="group flex items-start gap-2 px-3 py-2">
      <Checkbox
        className="mt-0.5"
        checked={!!item.done_at}
        disabled={!canToggle}
        aria-label={item.text}
        onCheckedChange={(v) =>
          void call("task_check_item_toggle", { p_id: item.id, p_done: v === true })
        }
      />
      <div className="min-w-0 flex-1">
        {edit !== null ? (
          <Input
            autoFocus
            aria-label="Текст пункта"
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            onBlur={async () => {
              if (edit.trim() && edit.trim() !== item.text)
                await save(edit.trim(), item.assignee_id);
              setEdit(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEdit(null);
            }}
          />
        ) : (
          <button
            type="button"
            disabled={!canWork}
            onClick={() => setEdit(item.text)}
            title={canWork ? "Изменить пункт" : undefined}
            className={cn(
              "block w-full text-left text-sm break-words",
              item.done_at && "text-muted-foreground line-through",
            )}
          >
            {item.text}
          </button>
        )}
        {item.done_at && (
          <span className="text-xs text-muted-foreground">
            {item.done_by ? name(item.done_by) : ""}, {formatDateTime(item.done_at)}
          </span>
        )}
      </div>
      <Popover open={pick} onOpenChange={setPick}>
        <PopoverTrigger asChild disabled={!canWork}>
          <button
            type="button"
            className="shrink-0 rounded-full text-sm text-muted-foreground hover:text-foreground disabled:cursor-default"
            aria-label={
              item.assignee_id ? `Исполнитель пункта: ${name(item.assignee_id)}` : "Назначить пункт"
            }
          >
            {item.assignee_id ? (
              // Пункт «на имя» (общая задача на нескольких) — только аватарка.
              item.text === name(item.assignee_id) ? (
                <PersonLine
                  id={item.assignee_id}
                  size="xs"
                  className="max-w-7 [&>span:last-child]:sr-only"
                />
              ) : (
                <PersonLine id={item.assignee_id} size="xs" className="max-w-40" />
              )
            ) : (
              canWork && (
                <UserPlus className="size-4 opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100" />
              )
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-3">
          <PeoplePicker
            single
            selected={item.assignee_id ? [item.assignee_id] : []}
            onToggle={(uid) => {
              setPick(false);
              void save(item.text, uid === item.assignee_id ? null : uid);
            }}
          />
        </PopoverContent>
      </Popover>
      {canWork && (
        <TaskMenu
          label={`Пункт «${item.text}»: действия`}
          reveal
          className="-my-1 size-7"
          items={[
            { label: "Изменить", icon: Pencil, run: () => setEdit(item.text) },
            { label: "Назначить исполнителя", icon: UserPlus, run: () => setPick(true) },
            "separator",
            {
              label: "Удалить пункт",
              icon: Trash2,
              danger: true,
              run: async () => {
                const ok = await confirm({
                  title: "Удалить пункт?",
                  description: `«${item.text}» пропадёт из чек-листа.`,
                  confirmLabel: "Удалить",
                });
                if (ok) void call("task_check_item_delete", { p_id: item.id });
              },
            },
          ]}
        />
      )}
      {confirmDialog}
    </li>
  );
}
