/**
 * Каналы и состав из оргструктуры (TASKS_CHATS_PLAN.md, этап 2: 2.3, 2.5,
 * 3.3): редактор источников состава (вся компания, подразделения), блок
 * «Кто в чате автоматически» в сведениях чата, «Прочитал» под постом канала
 * и окно «Кто отметил «Прочитал»» с напоминанием. Права — у базы
 * (db/migrations/2026-11-08_zzzzz_chat_channels.sql).
 */
import { UnitScopeFields } from "@/components/people/unit-scope-fields";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, CheckCheck, Loader2, Plus, Settings2, X } from "lucide-react";
import { toast } from "sonner";

import { PersonChip } from "@/components/people/person-card";
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
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ackListQuery,
  chatErrorText,
  chatSourcesQuery,
  remindAck,
  saveChatSources,
  useSourceOptions,
} from "@/lib/chats/data";
import { sourceText } from "@/lib/chats/content";
import { usePeople } from "@/lib/chats/people";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ChatMessage, ChatRow, ChatSource } from "@/lib/chats/types";
import { companyStructureQuery, unitChildren } from "@/lib/company";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Подразделения деревом (с отступом), только разрешённые. */
function useUnitOptions(allowed: string[]) {
  const { data: units = [] } = useQuery(companyStructureQuery);
  return useMemo(() => {
    const ok = new Set(allowed);
    const children = unitChildren(units);
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const u of children.get(parent) ?? []) {
        if (ok.has(u.id)) out.push({ id: u.id, name: u.name, depth });
        walk(u.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [units, allowed]);
}

/** Редактор источников: «Вся компания» и подразделения. */
export function SourcesEditor({
  value,
  onChange,
}: {
  value: ChatSource[];
  onChange: (v: ChatSource[]) => void;
}) {
  const opts = useSourceOptions();
  const { people } = usePeople();
  const unitOptions = useUnitOptions(opts.units);
  const hasAll = value.some((s) => s.kind === "all");
  const set = (i: number, patch: Partial<ChatSource>) =>
    onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const free = unitOptions.find((u) => !value.some((s) => s.unit_id === u.id));
  return (
    <div className="space-y-3">
      {value.map((s, i) => (
        <div
          key={`${s.kind}:${s.unit_id ?? "all"}:${i}`}
          className="space-y-3 rounded-lg border p-3"
        >
          <div className="flex items-center gap-2">
            {s.kind === "all" ? (
              <span className="flex-1 text-sm font-medium">Вся компания — все сотрудники</span>
            ) : (
              <Select value={s.unit_id ?? ""} onValueChange={(id) => set(i, { unit_id: id })}>
                <SelectTrigger aria-label="Подразделение" className="flex-1">
                  <SelectValue placeholder={s.unit_name ?? "Подразделение"} />
                </SelectTrigger>
                <SelectContent>
                  {unitOptions.map((u) => (
                    <SelectItem
                      key={u.id}
                      value={u.id}
                      disabled={u.id !== s.unit_id && value.some((x) => x.unit_id === u.id)}
                    >
                      <span style={{ paddingLeft: `${u.depth * 12}px` }}>{u.name}</span>
                    </SelectItem>
                  ))}
                  {s.unit_id && !unitOptions.some((u) => u.id === s.unit_id) && (
                    <SelectItem value={s.unit_id}>{s.unit_name ?? "Подразделение"}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Убрать"
              title="Убрать"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X className="size-4" />
            </Button>
          </div>
          {s.kind === "unit" && (
            <UnitScopeFields
              scope={s.scope}
              withSubunits={s.with_subunits}
              onChange={(v) => set(i, { scope: v.scope, with_subunits: v.withSubunits })}
            />
          )}
        </div>
      ))}
      {hasAll && (
        <InfoNote variant="info">
          Канал увидят все сотрудники ({people.length} {peopleWord(people.length)}). Новые
          сотрудники попадут сюда сами.
        </InfoNote>
      )}
      <div className="flex flex-wrap gap-2">
        {free && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([
                ...value,
                { kind: "unit", unit_id: free.id, scope: "all", with_subunits: true },
              ])
            }
          >
            <Plus className="size-4" /> Подразделение
          </Button>
        )}
        {opts.announce && !hasAll && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([
                ...value,
                { kind: "all", unit_id: null, scope: "all", with_subunits: true },
              ])
            }
          >
            <Plus className="size-4" /> Вся компания
          </Button>
        )}
      </div>
    </div>
  );
}

function peopleWord(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "человека";
  return "человек";
}

/** «Кто в чате автоматически» в сведениях чата. */
export function ChatSourcesBlock({ chat, open }: { chat: ChatRow; open: boolean }) {
  const { data } = useQuery({ ...chatSourcesQuery(chat.id), enabled: open });
  const opts = useSourceOptions();
  const [editing, setEditing] = useState(false);
  const sources = data?.sources ?? [];
  const canEdit = !!data?.can_edit && (opts.any || sources.length > 0);
  if (!data || (sources.length === 0 && !canEdit)) return null;
  return (
    <div className="space-y-2 border-b p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Кто в чате автоматически</h3>
        {canEdit && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditing(true)}>
            <Settings2 className="size-4" /> {sources.length ? "Изменить" : "Привязать"}
          </Button>
        )}
      </div>
      {sources.length > 0 ? (
        <ul className="space-y-1">
          {sources.map((s) => (
            <li key={`${s.kind}:${s.unit_id}`} className="flex items-start gap-2 text-sm">
              <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              {sourceText(s)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Привяжите подразделение — новые сотрудники будут попадать в чат сами.
        </p>
      )}
      {sources.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Новые сотрудники подразделения попадают в чат сами, ушедшие — уходят. Вручную их не
          убрать.
        </p>
      )}
      <SourcesDialog
        chatId={chat.id}
        initial={sources}
        open={editing}
        onClose={() => setEditing(false)}
      />
    </div>
  );
}

function SourcesDialog({
  chatId,
  initial,
  open,
  onClose,
}: {
  chatId: string;
  initial: ChatSource[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {open && <SourcesForm chatId={chatId} initial={initial} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function SourcesForm({
  chatId,
  initial,
  onClose,
}: {
  chatId: string;
  initial: ChatSource[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState<ChatSource[]>(initial);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Кто в чате автоматически</DialogTitle>
        <DialogDescription>
          Люди подразделений попадают в чат сами и уходят, когда уходят из подразделения.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <SourcesEditor value={value} onChange={setValue} />
        {value.length === 0 && initial.length > 0 && (
          <InfoNote>
            Участники из оргструктуры уйдут из чата, добавленные вручную — останутся.
          </InfoNote>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await saveChatSources(qc, chatId, value);
              toast.success("Состав сохранён");
              onClose();
            } catch (e) {
              toast.error(chatErrorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 className="animate-spin" />} Сохранить
        </Button>
      </DialogFooter>
    </>
  );
}

/** Под постом канала: «Прочитал» и счётчик (автору и админам — с окном). */
export function AckBar({
  m,
  mine,
  canSeeAcks,
  onAck,
  onOpenList,
}: {
  m: ChatMessage;
  mine: boolean;
  canSeeAcks: boolean;
  onAck: () => void;
  onOpenList: () => void;
}) {
  const ack = m.ack;
  if (!ack) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-black/5 pt-2">
      {!mine &&
        (ack.mine ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-3.5" /> Вы прочитали
          </span>
        ) : (
          <Button size="sm" className="h-7 px-3 text-xs" onClick={onAck}>
            <Check className="size-3.5" /> Прочитал(а)
          </Button>
        ))}
      {canSeeAcks && (
        <button
          type="button"
          onClick={onOpenList}
          className={cn(
            "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline",
            !mine && "ml-auto",
          )}
        >
          <CheckCheck className="size-3.5" />
          Прочитали {ack.count} из {ack.total}
        </button>
      )}
    </div>
  );
}

/** Кто отметил «Прочитал» и кто нет; «Напомнить» не отметившим; «Закрыть». */
export function AckDialog({
  message,
  onClose,
}: {
  message: ChatMessage | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!message} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {message && <AckBody key={message.id} message={message} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function AckBody({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isPending } = useQuery(ackListQuery(message.id));
  const [tab, setTab] = useState<"pending" | "acked">("pending");
  const [busy, setBusy] = useState(false);
  const acked = data?.acked ?? [];
  const pending = data?.pending ?? [];
  const remindedRecently =
    !!data?.reminded_at && Date.now() - new Date(data.reminded_at).getTime() < 3_600_000;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Кто отметил «Прочитал»</DialogTitle>
        <DialogDescription className="line-clamp-2">
          {message.text || "Сообщение"}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "acked")}>
          <TabsList className="w-full">
            <TabsTrigger value="pending" className="flex-1">
              Ещё нет · {pending.length}
            </TabsTrigger>
            <TabsTrigger value="acked" className="flex-1">
              Прочитали · {acked.length}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {isPending ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <ul className="max-h-80 space-y-1.5 overflow-y-auto">
            {tab === "acked"
              ? acked.map((a) => (
                  <li key={a.user_id} className="flex items-center gap-2 text-sm">
                    <PersonChip userId={a.user_id} className="min-w-0 flex-1" />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDateTime(a.at)}
                    </span>
                  </li>
                ))
              : pending.map((id) => (
                  <li key={id} className="text-sm">
                    <PersonChip userId={id} />
                  </li>
                ))}
            {(tab === "acked" ? acked : pending).length === 0 && (
              <li className="py-4 text-center text-sm text-muted-foreground">
                {tab === "acked" ? "Пока никто" : "Прочитали все"}
              </li>
            )}
          </ul>
        )}
      </DialogBody>
      <DialogFooter className="items-center">
        {data?.reminded_at && (
          <span className="mr-auto text-xs text-muted-foreground max-sm:w-full">
            Напоминали {formatDateTime(data.reminded_at)}
          </span>
        )}
        <Button variant="outline" onClick={onClose}>
          Закрыть
        </Button>
        <Button
          variant="outline"
          disabled={busy || pending.length === 0 || remindedRecently}
          title={remindedRecently ? "Напоминать можно не чаще раза в час" : undefined}
          onClick={async () => {
            setBusy(true);
            try {
              const n = await remindAck(message.id);
              toast.success(`Напомнили: ${n}`);
              await qc.invalidateQueries({ queryKey: ["chat_acks", message.id] });
            } catch (e) {
              toast.error(chatErrorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 className="animate-spin" />} Напомнить не прочитавшим
        </Button>
      </DialogFooter>
    </>
  );
}
