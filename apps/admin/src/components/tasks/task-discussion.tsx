/**
 * Обсуждение и история задачи (план, 4.6, 4.7).
 *
 * Обсуждение — чат задачи из мессенджера (те же поиск, упоминания, файлы):
 * не создаётся сам — «Начать обсуждение»; участники чата — участники
 * задачи; в «Чатах» — папка «Задачи». Руководителю, который не участник,
 * чат не виден — пусть станет наблюдателем.
 *
 * История — отдельная вкладка: кто, что, когда, было → стало, причина; в
 * обсуждение не подмешивается.
 */
import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";

import { PersonLine } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import { useChatList } from "@/lib/chats/data";
import { usePeople } from "@/lib/chats/people";
import { formatDateTime } from "@/lib/format";
import { taskAction, taskErrorText, useTaskHistory } from "@/lib/tasks/data";
import { eventText } from "@/lib/tasks/logic";
import type { TaskFull } from "@/lib/tasks/types";

const ChatView = lazy(() =>
  import("@/components/chats/chat-view").then((m) => ({ default: m.ChatView })),
);

export function TaskDiscussion({
  task,
  me,
  isMember,
}: {
  task: TaskFull;
  me: string;
  isMember: boolean;
}) {
  const qc = useQueryClient();
  const { data: chats, isPending } = useChatList();
  const chat = task.chat_id ? chats?.find((c) => c.id === task.chat_id) : undefined;

  if (!task.chat_id) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          Обсуждения пока нет. Чат задачи появится в «Чатах» → «Задачи» у всех участников — без
          лишних служебных сообщений.
        </p>
        {isMember ? (
          <Button
            onClick={() =>
              void taskAction(qc, "task_chat_open", { p_task: task.id })
                .then(() => qc.invalidateQueries({ queryKey: ["chat_list"] }))
                .catch((e) => toast.error(taskErrorText(e)))
            }
          >
            <MessageSquarePlus className="size-4" /> Начать обсуждение
          </Button>
        ) : (
          <p className="text-sm">Обсуждение видят участники задачи.</p>
        )}
      </div>
    );
  }
  if (!chat) {
    return isPending ? (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    ) : (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        Обсуждение видят участники задачи — станьте наблюдателем, чтобы читать его.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="h-[min(560px,70dvh)] overflow-hidden rounded-lg border">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <ChatView chat={chat} me={me} focusSeq={null} onBack={() => {}} onInfo={() => {}} />
        </Suspense>
      </div>
      <Button variant="ghost" size="sm" asChild>
        <Link to="/chats/$chatId" params={{ chatId: chat.id }}>
          <ExternalLink className="size-4" /> Открыть в «Чатах»
        </Link>
      </Button>
    </div>
  );
}

export function TaskHistory({ task, tz }: { task: TaskFull; tz: string }) {
  const { name } = usePeople();
  const { data, isPending } = useTaskHistory(task.id);
  if (isPending)
    return (
      <div className="flex h-24 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  return (
    <ol className="space-y-3">
      {(data ?? []).map((e) => (
        <li key={e.id} className="flex gap-3 text-sm">
          <span className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDateTime(e.created_at)}
          </span>
          <span className="min-w-0 flex-1">
            <PersonLine id={e.actor_id} size="xs" className="mr-1 align-middle font-medium" />
            <span className="align-middle">{eventText(e, name, tz)}</span>
            {e.reason && (
              <span className="mt-1 block rounded-md bg-muted/60 px-2 py-1 text-muted-foreground">
                {e.reason}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
