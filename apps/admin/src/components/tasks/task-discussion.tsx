/**
 * Обсуждение и история задачи (план, 4.6, 4.7; UI_REVIEW_CHATS_TASKS_CALENDAR.md, 4.3.13).
 *
 * Обсуждение — чат задачи из мессенджера (те же поиск, упоминания, файлы).
 * Чата нет, пока кто-то не напишет: поле «Написать комментарий…» видно
 * всегда, первое сообщение заводит чат (`task_chat_open`) — решение «чат по
 * кнопке» сохраняется, кнопка — само поле. Участники чата — участники
 * задачи; в «Чатах» — папка «Задачи». Руководителю, который не участник,
 * чат не виден — рядом кнопка «Наблюдать».
 *
 * История — отдельная вкладка: кто, что, когда (в поясе человека), было →
 * стало, причина; в обсуждение не подмешивается.
 */
import { lazy, Suspense, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Eye, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { PersonLine } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { chatErrorText, sendMessage, useChatList } from "@/lib/chats/data";
import { usePeople } from "@/lib/chats/people";
import type { ChatDoc } from "@/lib/chats/types";
import {
  invalidateTasks,
  taskAction,
  taskErrorText,
  taskRpc,
  useTaskHistory,
} from "@/lib/tasks/data";
import { eventText, formatMoment } from "@/lib/tasks/logic";
import type { TaskFull } from "@/lib/tasks/types";

const ChatView = lazy(() =>
  import("@/components/chats/chat-view").then((m) => ({ default: m.ChatView })),
);

/** Текст комментария → документ сообщения (абзац на строку). */
function textDoc(text: string): ChatDoc {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

export function TaskDiscussion({
  task,
  me,
  isMember,
}: {
  task: TaskFull;
  me: string;
  isMember: boolean;
}) {
  const { data: chats, isPending } = useChatList();
  const chat = task.chat_id ? chats?.find((c) => c.id === task.chat_id) : undefined;

  if (!task.chat_id) {
    return isMember ? (
      <FirstComment task={task} me={me} />
    ) : (
      <NotMember task={task} text="Обсуждение видят участники задачи — станьте наблюдателем." />
    );
  }
  if (!chat) {
    return isPending ? (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    ) : (
      <NotMember
        task={task}
        text="Обсуждение видят участники задачи — станьте наблюдателем, чтобы читать его."
      />
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

/** Поле первого комментария: отправка заводит чат задачи. */
function FirstComment({ task, me }: { task: TaskFull; me: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || busy || !me) return;
    setBusy(true);
    try {
      const chatId = await taskRpc<string>("task_chat_open", { p_task: task.id });
      await sendMessage(qc, {
        chatId,
        content: textDoc(t),
        text: t,
        replyTo: null,
        attachments: [],
        authorId: me,
      });
      setText("");
      await qc.invalidateQueries({ queryKey: ["chat_list"] });
      void invalidateTasks(qc);
    } catch (e) {
      toast.error(
        e instanceof Error && /^chat_/.test(e.message) ? chatErrorText(e) : taskErrorText(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Комментариев пока нет. Напишите первым — обсуждение увидят все участники задачи, оно будет и
        в «Чатах» → «Задачи».
      </p>
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={text}
          placeholder="Написать комментарий…"
          aria-label="Комментарий"
          className="min-h-10"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button
          size="icon"
          aria-label="Отправить"
          title="Отправить (Enter)"
          disabled={!text.trim() || busy}
          onClick={() => void send()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Enter — отправить, Shift+Enter — новая строка</p>
    </div>
  );
}

function NotMember({ task, text }: { task: TaskFull; text: string }) {
  const qc = useQueryClient();
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      <Button
        variant="outline"
        onClick={() =>
          void taskAction(qc, "task_watch", { p_task: task.id, p_on: true })
            .then(() => {
              void qc.invalidateQueries({ queryKey: ["chat_list"] });
              toast.success("Вы наблюдатель задачи");
            })
            .catch((e) => toast.error(taskErrorText(e)))
        }
      >
        <Eye className="size-4" /> Наблюдать
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
            {formatMoment(e.created_at, tz)}
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
