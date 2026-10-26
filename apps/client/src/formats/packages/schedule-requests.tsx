import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Ruler, UserHeart } from "@solar-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WorkoutDrawer, type WorkoutDrawerData } from "@/components/workout-drawer";
import { useAuth } from "@/hooks/use-auth";
import { useClubSettings } from "@/hooks/use-club-settings";
import { useT, type Translator } from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { homeBookingsQuery } from "@/lib/home-queries";
import { FormattedText } from "@/lib/formatted-text";
import { cn } from "@/lib/utils";
import {
  diagnosticDescription,
  isDiagnostic,
  packEntryToDrawerData,
  type PackEntry,
} from "./entries";
import { diagnosticsBalance, packMyMembershipsQuery } from "./queries";
import {
  GOALS,
  myGoalsQuery,
  myOpenRequestsQuery,
  sendClientRequest,
  type Goal,
  type RequestKind,
} from "./requests";
import { PackWorkoutCard } from "./workout-card";

/**
 * Вкладки «Персональные» и «Диагностика» расписания пакетного приложения
 * (решение владельца 2026-10-15). Записи на них клиент сам не делает: он
 * отправляет заявку администратору (формы ниже), тот согласует время с
 * тренером и ставит занятие в расписание. Свои диагностики клиент видит во
 * вкладке «Диагностика» и на главной (карточка с чёрной полоской), отменяет
 * и добавляет в календарь — как запись на тренировку.
 */

/** «12 октября»; заявку отправили сегодня — «сегодня». */
function sentLabel(iso: string, t: Translator) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t("сегодня");
  return t.date(d, { day: "numeric", month: "long" });
}

/** Заявка уже у администратора — вместо формы. */
function RequestSent({ createdAt, kind }: { createdAt: string; kind: RequestKind }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
      <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" weight="Bold" />
      <div>
        <div className="font-semibold">
          {t("Заявка отправлена {date}", { date: sentLabel(createdAt, t) })}
        </div>
        <div className="mt-0.5">
          {kind === "personal"
            ? t(
                "Администратор свяжется с вами, чтобы подобрать тренера и согласовать расписание персональных занятий.",
              )
            : t(
                "Администратор согласует время с тренером и добавит диагностику в ваше расписание.",
              )}
        </div>
      </div>
    </div>
  );
}

function useSendRequest(kind: RequestKind) {
  const t = useT();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const send = async (input: { goals?: Goal[]; goalOther?: string; comment?: string }) => {
    if (sending) return false;
    setSending(true);
    try {
      const res = await sendClientRequest({ kind, ...input });
      if (!res.ok && res.reason !== "pending") {
        toast.error(
          res.reason === "no_client"
            ? t("Профиль клиента не найден. Обратитесь к администратору.")
            : t("Не удалось отправить заявку: {error}", { error: res.reason }),
        );
        return false;
      }
      // Уже есть неотработанная — тоже «отправлена»: покажем её дату.
      await queryClient.invalidateQueries({
        queryKey: myOpenRequestsQuery(user?.id ?? null).queryKey,
      });
      if (res.ok) toast.success(t("Заявка отправлена администратору"));
      return true;
    } finally {
      setSending(false);
    }
  };
  return { send, sending };
}

// ---- «Персональные» ----

/** Поле на серой карточке — белое (решение владельца 2026-10-15: серое не видно). */
const WHITE_FIELD = "bg-background focus:bg-background";

/** Персональных на текущих абонементах (у пакета тренировок — подарочные). */
function personalBalance(rows: { status: string; personal_left: number | null }[]) {
  return rows
    .filter((m) => m.status === "active" || m.status === "frozen")
    .reduce((sum, m) => sum + Math.max(0, m.personal_left ?? 0), 0);
}

export function PersonalRequestTab() {
  const t = useT();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const open = useQuery(myOpenRequestsQuery(userId));
  const goals = useQuery(myGoalsQuery(userId));
  const mine = useQuery(packMyMembershipsQuery(userId));
  const personalLeft = personalBalance(mine.data ?? []);
  const pendingAt = open.data?.personal;

  return (
    <div className="space-y-4 p-4 pb-24">
      <Card className="rounded-2xl p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15">
            <UserHeart className="h-7 w-7 text-primary" weight="BoldDuotone" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold leading-tight">{t("Персональные тренировки")}</h2>
            {/* Остаток на текущем абонементе — только если он есть. */}
            {personalLeft > 0 && (
              <div className="mt-0.5 text-sm font-medium text-primary">
                {t("На балансе: {balance}", {
                  balance: t.plural(
                    personalLeft,
                    "{n} персональная|{n} персональные|{n} персональных",
                  ),
                })}
              </div>
            )}
          </div>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-foreground/90">
          {t(
            "Оставьте заявку — она придёт администратору студии. Администратор свяжется с вами, чтобы подобрать тренера и согласовать расписание персональных занятий.",
          )}
        </p>
      </Card>

      {open.isPending || goals.isPending ? (
        <Card className="h-64 animate-pulse rounded-2xl bg-muted" />
      ) : pendingAt ? (
        <RequestSent createdAt={pendingAt} kind="personal" />
      ) : (
        // key — чтобы цель из анкеты подставилась, когда анкета догрузится.
        <PersonalRequestForm
          key={goals.data?.primary_goal ?? "none"}
          initialGoal={goals.data?.primary_goal ?? null}
          initialOther={goals.data?.goal_other ?? ""}
        />
      )}
    </div>
  );
}

function PersonalRequestForm({
  initialGoal,
  initialOther,
}: {
  initialGoal: string | null;
  initialOther: string;
}) {
  const t = useT();
  const known = GOALS.some((g) => g.v === initialGoal);
  const [picked, setPicked] = useState<Goal[]>(() => (known ? [initialGoal as Goal] : []));
  const [other, setOther] = useState(initialGoal === "other" ? initialOther : "");
  const [comment, setComment] = useState("");
  const { send, sending } = useSendRequest("personal");

  const toggle = (g: Goal) =>
    setPicked((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

  const submit = async () => {
    if (picked.includes("other") && !other.trim()) {
      toast.error(t("Напишите вашу цель"));
      return;
    }
    await send({
      goals: picked,
      goalOther: picked.includes("other") ? other : undefined,
      comment,
    });
  };

  return (
    <Card className="space-y-4 rounded-2xl p-5">
      <div>
        <h3 className="text-lg font-semibold">{t("Ваша цель")}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {known
            ? t("Цель из вашей анкеты уже отмечена — можно добавить другие.")
            : t("Отметьте, чего хотите добиться, — можно несколько.")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {GOALS.map((g) => {
            const active = picked.includes(g.v);
            return (
              <button
                key={g.v}
                type="button"
                onClick={() => toggle(g.v)}
                aria-pressed={active}
                className={cn(
                  "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-card text-card-foreground",
                )}
              >
                {active && <CheckCircle className="h-4 w-4 shrink-0 text-primary" weight="Bold" />}
                {t(g.label)}
              </button>
            );
          })}
        </div>
        {picked.includes("other") && (
          <Input
            className={cn("mt-3", WHITE_FIELD)}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            maxLength={300}
            placeholder={t("Ваша цель")}
          />
        )}
      </div>

      <div>
        <h3 className="text-lg font-semibold">{t("Комментарий")}</h3>
        <Textarea
          className={cn("mt-2", WHITE_FIELD)}
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={1000}
          placeholder={t("Удобные дни и время, пожелания к тренеру")}
        />
      </div>

      <Button className="w-full" onClick={submit} disabled={sending}>
        {sending ? "..." : t("Отправить заявку")}
      </Button>
    </Card>
  );
}

// ---- «Диагностика» ----

export function DiagnosticsTab() {
  const t = useT();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  const homeSettings = useClubSettings("home");
  const mine = useQuery(packMyMembershipsQuery(userId));
  const bookings = useQuery(homeBookingsQuery(userId));
  const open = useQuery(myOpenRequestsQuery(userId));
  const { send, sending } = useSendRequest("diagnostic");
  const [openEntry, setOpenEntry] = useState<WorkoutDrawerData | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const balance = diagnosticsBalance(mine.data ?? []);
  const pendingAt = open.data?.diagnostic;

  // Свои предстоящие диагностики — из того же запроса, что записи на главной.
  const diagnostics = useMemo(() => {
    const now = Date.now();
    return (bookings.data ?? [])
      .flatMap((b) => (b.entry ? [b.entry as unknown as PackEntry] : []))
      .filter((e) => isDiagnostic(e) && new Date(e.starts_at).getTime() >= now)
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }, [bookings.data]);

  async function cancel(entryId: string) {
    if (pendingId) return;
    setPendingId(entryId);
    const { data, error } = await supabase.rpc("cancel_schedule_booking", {
      p_entry_id: entryId,
      p_reason: null,
    });
    setPendingId(null);
    if (error) {
      toast.error(t("Не удалось отменить запись: {error}", { error: error.message }));
      return;
    }
    const res = data as { ok: boolean; reason?: string } | null;
    if (res?.ok) {
      queryClient.setQueryData(homeBookingsQuery(userId).queryKey, (prev) =>
        prev?.filter((b) => b.entry_id !== entryId),
      );
      setOpenEntry(null);
      toast.success(t("Диагностика отменена"));
    } else if (res?.reason) {
      toast.error(t("Не удалось отменить запись: {error}", { error: res.reason }));
    }
  }

  return (
    <div className="space-y-4 p-4 pb-24">
      {/* Шапка — как у «Персональных»: иконка, заголовок, остаток розовым. */}
      <Card className="rounded-2xl p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15">
            <Ruler className="h-7 w-7 text-primary" weight="BoldDuotone" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold leading-tight">{t("Диагностика тела")}</h2>
            {balance > 0 && (
              <div className="mt-0.5 text-sm font-medium text-primary">
                {t("На балансе: {balance}", {
                  balance: t.plural(balance, "{n} диагностика|{n} диагностики|{n} диагностик"),
                })}
              </div>
            )}
          </div>
        </div>
        <FormattedText
          text={diagnosticDescription(t)}
          className="mt-3 text-[15px] leading-relaxed text-foreground/90"
        />
        <p className="mt-3 text-sm text-muted-foreground">
          {t("Диагностики входят в абонементы на 24, 36 и 50 занятий.")}
        </p>
      </Card>

      {diagnostics.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("Вы записаны")}</h2>
          {diagnostics.map((e) => (
            <div key={e.id} className="space-y-1">
              <div className="text-xs font-semibold text-muted-foreground">
                {t.capitalize(
                  t.date(new Date(e.starts_at), { weekday: "long", day: "numeric", month: "long" }),
                )}
              </div>
              <PackWorkoutCard
                entry={e}
                isBooked
                onOpen={() => setOpenEntry(packEntryToDrawerData(e, t))}
              />
            </div>
          ))}
        </section>
      )}

      <Card className="space-y-3 rounded-2xl p-5">
        <h2 className="text-xl font-semibold leading-tight">{t("Записаться на диагностику")}</h2>
        {open.isPending || mine.isPending ? (
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        ) : pendingAt ? (
          <RequestSent createdAt={pendingAt} kind="diagnostic" />
        ) : balance > 0 ? (
          <>
            <p className="text-[15px] leading-relaxed text-foreground/90">
              {t(
                "Заявка поступит администратору — он согласует время с тренером и добавит диагностику в ваше расписание.",
              )}
            </p>
            <Button className="w-full" onClick={() => send({})} disabled={sending}>
              {sending ? "..." : t("Отправить заявку")}
            </Button>
          </>
        ) : (
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            {t(
              "На ваших абонементах нет диагностик. Узнать, как их получить, можно у администратора студии.",
            )}
          </p>
        )}
      </Card>

      <WorkoutDrawer
        data={openEntry}
        open={openEntry !== null}
        onOpenChange={(o) => {
          if (!o) setOpenEntry(null);
        }}
        isBooked
        isPending={openEntry ? pendingId === openEntry.id : false}
        cancelMinutes={homeSettings.cancel_booking_minutes}
        onBook={() => {
          if (openEntry) cancel(openEntry.id);
        }}
      />
    </div>
  );
}
