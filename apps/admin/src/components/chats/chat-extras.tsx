/**
 * Отложенные сообщения и опросы чатов (TASKS_CHATS_PLAN.md, этап 2: Д.6,
 * 2.16): окно «Отправить позже» (быстрые варианты и своё время), плашка и
 * список запланированных над полем ввода, окно «Новый опрос» и опрос в
 * сообщении. Схема — db/migrations/2026-11-08_zzzzzz_chat_scheduled_polls.sql.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BarChart3, Check, Clock, Loader2, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { StaffAvatar } from "@/components/employee-photo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { scheduleOptions, scheduledLabel, toLocalInput } from "@/lib/chats/content";
import {
  chatErrorText,
  createPoll,
  deleteScheduled,
  rescheduleMessage,
  scheduledQuery,
  sendScheduledNow,
  votePoll,
} from "@/lib/chats/data";
import { usePeople } from "@/lib/chats/people";
import type { ChatMessage, ChatScheduled } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

// ---- Время отправки -----------------------------------------------------------------

export function ScheduleDialog({
  open,
  title = "Отправить позже",
  initial,
  onClose,
  onPick,
}: {
  open: boolean;
  title?: string;
  initial?: Date;
  onClose: () => void;
  onPick: (at: Date) => Promise<void> | void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {open && <ScheduleForm title={title} initial={initial} onClose={onClose} onPick={onPick} />}
      </DialogContent>
    </Dialog>
  );
}

function ScheduleForm({
  title,
  initial,
  onClose,
  onPick,
}: {
  title: string;
  initial?: Date;
  onClose: () => void;
  onPick: (at: Date) => Promise<void> | void;
}) {
  const quick = useMemo(() => scheduleOptions(new Date()), []);
  const [value, setValue] = useState(() => toLocalInput(initial ?? quick[0].at));
  const [busy, setBusy] = useState(false);
  const pick = async (at: Date) => {
    if (!(at.getTime() > Date.now() + 30_000)) {
      toast.error("Выберите время позже, чем через минуту");
      return;
    }
    setBusy(true);
    try {
      await onPick(at);
      onClose();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Сообщение уйдёт само в выбранное время — даже если портал закрыт.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div className="grid gap-2">
          {quick.map((q) => (
            <Button
              key={q.label}
              variant="outline"
              className="justify-start"
              disabled={busy}
              onClick={() => void pick(q.at)}
            >
              <Clock className="size-4" /> {q.label}
            </Button>
          ))}
        </div>
        <FormField label="Своё время" htmlFor="chat-schedule-at">
          <Input
            id="chat-schedule-at"
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy || !value} onClick={() => void pick(new Date(value))}>
          {busy && <Loader2 className="animate-spin" />} Запланировать
        </Button>
      </DialogFooter>
    </>
  );
}

// ---- Запланированные ----------------------------------------------------------------

/** Плашка над полем ввода: «Запланировано: 2» — список по нажатию. */
export function ScheduledBar({
  chatId,
  openList,
  onOpenList,
}: {
  chatId: string;
  openList: boolean;
  onOpenList: (open: boolean) => void;
}) {
  const { data = [] } = useQuery(scheduledQuery(chatId));
  const failed = data.filter((s) => s.status === "failed").length;
  return (
    <>
      {data.length > 0 && (
        <button
          type="button"
          onClick={() => onOpenList(true)}
          className={cn(
            "flex w-full items-center gap-2 border-t bg-background px-4 py-1.5 text-left text-xs hover:bg-muted/50",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {failed ? <AlertCircle className="size-3.5" /> : <Clock className="size-3.5" />}
          {failed
            ? `Не отправлено: ${failed} — открыть`
            : `Запланировано: ${data.length} · ближайшее ${scheduledLabel(data[0].send_at, new Date())}`}
        </button>
      )}
      <Dialog open={openList} onOpenChange={onOpenList}>
        <DialogContent className="sm:max-w-lg">
          {openList && <ScheduledList items={data} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScheduledList({ items }: { items: ChatScheduled[] }) {
  const qc = useQueryClient();
  const [moving, setMoving] = useState<ChatScheduled | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, run: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      await run();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Отложенные сообщения</DialogTitle>
        <DialogDescription>Видите только вы. Уйдут сами в своё время.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-2">
        {items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Ничего не запланировано</p>
        )}
        {items.map((s) => (
          <div
            key={s.id}
            className={cn(
              "space-y-2 rounded-lg border p-3",
              s.status === "failed" && "border-destructive/50",
            )}
          >
            <div className="flex items-center gap-2 text-xs">
              {s.status === "failed" ? (
                <span className="inline-flex items-center gap-1 font-medium text-destructive">
                  <AlertCircle className="size-3.5" /> Не отправлено: {chatErrorText(s.error ?? "")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Clock className="size-3.5" /> {scheduledLabel(s.send_at, new Date())}
                </span>
              )}
            </div>
            <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap">
              {s.text || `Файлы: ${s.attachments.map((a) => a.name).join(", ")}`}
            </p>
            {s.text && s.attachments.length > 0 && (
              <p className="text-xs text-muted-foreground">+ файлов: {s.attachments.length}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === s.id}
                onClick={() => void act(s.id, () => sendScheduledNow(qc, s), "Отправлено")}
              >
                <Send className="size-3.5" /> Отправить сейчас
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMoving(s)}>
                <Clock className="size-3.5" /> Другое время
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={busy === s.id}
                onClick={() => void act(s.id, () => deleteScheduled(qc, s))}
              >
                <Trash2 className="size-3.5" /> Удалить
              </Button>
            </div>
          </div>
        ))}
      </DialogBody>
      <ScheduleDialog
        open={!!moving}
        title="Другое время"
        initial={moving ? new Date(moving.send_at) : undefined}
        onClose={() => setMoving(null)}
        onPick={(at) => (moving ? rescheduleMessage(qc, moving, at) : undefined)}
      />
    </>
  );
}

// ---- Опросы -------------------------------------------------------------------------

export function PollDialog({
  chatId,
  open,
  onClose,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-md">
        {open && <PollForm chatId={chatId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function PollForm({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const submit = async () => {
    if (!question.trim()) {
      setError("Напишите вопрос");
      return;
    }
    if (filled.length < 2) {
      toast.error("Нужно хотя бы два варианта");
      return;
    }
    if (new Set(filled.map((o) => o.toLowerCase())).size !== filled.length) {
      toast.error("Варианты повторяются");
      return;
    }
    setBusy(true);
    try {
      await createPoll(qc, chatId, {
        question: question.trim(),
        options: filled,
        multiple,
        anonymous,
      });
      onClose();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Новый опрос</DialogTitle>
        <DialogDescription>Участники выбирают вариант прямо в сообщении.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Вопрос" required error={error}>
          <Input
            autoFocus
            maxLength={300}
            value={question}
            placeholder="Например: когда удобна планёрка?"
            onChange={(e) => {
              setQuestion(e.target.value);
              setError(null);
            }}
          />
        </FormField>
        <FormField label="Варианты" required htmlFor={null} hint="От 2 до 10">
          <div className="space-y-2">
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={o}
                  maxLength={100}
                  aria-label={`Вариант ${i + 1}`}
                  placeholder={`Вариант ${i + 1}`}
                  onChange={(e) =>
                    setOptions((x) => x.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && i === options.length - 1 && options.length < 10) {
                      e.preventDefault();
                      setOptions((x) => [...x, ""]);
                    }
                  }}
                />
                {options.length > 2 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    aria-label={`Убрать вариант ${i + 1}`}
                    onClick={() => setOptions((x) => x.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            {options.length < 10 && (
              <Button variant="outline" size="sm" onClick={() => setOptions((x) => [...x, ""])}>
                <Plus className="size-4" /> Вариант
              </Button>
            )}
          </div>
        </FormField>
        <SwitchRow title="Несколько ответов" checked={multiple} onCheckedChange={setMultiple} />
        <SwitchRow
          title="Анонимный"
          tip="Видно только, сколько выбрали каждый вариант, — без имён."
          checked={anonymous}
          onCheckedChange={setAnonymous}
        />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy} onClick={() => void submit()}>
          {busy && <Loader2 className="animate-spin" />} Отправить опрос
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Опрос в сообщении: выбор, результаты, «Отозвать голос». «Закрыть опрос» —
 * в меню сообщения, с подтверждением (UI_REVIEW, 3.10).
 */
export function PollView({ m }: { m: ChatMessage }) {
  const qc = useQueryClient();
  const { name, person } = usePeople();
  const poll = m.poll!;
  const voted = poll.options.some((o) => o.mine);
  const showResults = voted || poll.closed;
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<unknown>) => {
    setBusy(true);
    try {
      await p;
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const vote = (ids: string[]) => void run(votePoll(qc, m, ids)).then(() => setPicked([]));
  const max = Math.max(1, poll.voters);
  return (
    <div className="min-w-60 space-y-2">
      <div>
        <p className="flex items-start gap-1.5 font-semibold break-words">
          <BarChart3 className="mt-0.5 size-4 shrink-0 text-chat-accent" />
          {poll.question}
        </p>
        <p className="text-xs text-muted-foreground">
          {[
            poll.anonymous ? "Анонимный опрос" : "Опрос",
            poll.multiple ? "несколько ответов" : null,
            poll.closed ? "закрыт" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="space-y-1.5">
        {poll.options.map((o) => {
          const share = Math.round((o.count / max) * 100);
          if (showResults)
            return (
              <div key={o.id} className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums">
                    {share}%
                  </span>
                  <span className={cn("min-w-0 flex-1 break-words", o.mine && "font-medium")}>
                    {o.text}
                  </span>
                  {o.mine && <Check className="size-4 shrink-0 text-chat-accent" />}
                  {o.users && o.users.length > 0 && (
                    <span
                      className="flex shrink-0 -space-x-1.5"
                      title={o.users.map(name).join(", ")}
                    >
                      {o.users.slice(0, 3).map((u) => (
                        <StaffAvatar
                          key={u}
                          value={person(u)?.avatar_url ?? null}
                          name={name(u)}
                          className="size-5 text-[8px] ring-2 ring-background"
                        />
                      ))}
                    </span>
                  )}
                </div>
                <div className="ml-11 h-1.5 overflow-hidden rounded-full bg-black/5">
                  <div
                    className="h-full rounded-full bg-chat-accent transition-[width]"
                    style={{ width: `${share}%` }}
                  />
                </div>
              </div>
            );
          const on = picked.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              disabled={busy}
              aria-pressed={poll.multiple ? on : undefined}
              onClick={() =>
                poll.multiple
                  ? setPicked((x) => (on ? x.filter((y) => y !== o.id) : [...x, o.id]))
                  : vote([o.id])
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border bg-background/60 px-3 py-2 text-left text-sm transition-colors hover:border-chat-accent/60",
                on && "border-chat-accent bg-chat-accent-soft",
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center border",
                  poll.multiple ? "rounded" : "rounded-full",
                  on && "border-chat-accent bg-chat-accent text-white",
                )}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1 break-words">{o.text}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Проголосовали: {poll.voters}</span>
        {poll.multiple && !showResults && (
          <Button
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={busy || picked.length === 0}
            onClick={() => vote(picked)}
          >
            Голосовать
          </Button>
        )}
        {voted && !poll.closed && (
          <button
            type="button"
            className="hover:text-foreground hover:underline"
            disabled={busy}
            onClick={() => vote([])}
          >
            Отозвать голос
          </button>
        )}

        {busy && <Loader2 className="size-3.5 animate-spin" />}
      </div>
    </div>
  );
}
