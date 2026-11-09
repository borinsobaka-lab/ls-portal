/**
 * Видеозвонки чатов поверх портала (монтируется один раз в каркасе,
 * routes/_authenticated/route.tsx):
 *
 * - входящий звонок — окно «Принять / Отклонить» со звуком, пока у
 *   человека открыта вкладка портала (заголовок вкладки мигает);
 * - мой звонок — окно с конференцией Kinescope Speak (iframe по ссылке
 *   комнаты): во весь экран или свёрнуто в угол (на телефоне — плашкой
 *   «Идёт звонок · Вернуться» сверху, как в iOS: окно в углу закрывало поле
 *   ввода), «Открыть в новой вкладке», «Завершить» (личный) / «Выйти из
 *   звонка» (группа). Входящий — «Принять / Отклонить / Позже». Пока никто не
 *   ответил — гудки. Раз в 20 с — «я в звонке» (иначе база через 75 с
 *   считает, что человек вышел).
 *
 * Логика и данные — lib/chats/calls.ts, схема — 2026-11-08_zzz_chat_calls.sql.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, Loader2, Maximize, Minimize, PhoneOff, Video } from "lucide-react";
import { toast } from "sonner";

import { ChatAvatar } from "@/components/chats/chat-avatar";
import { StaffAvatar } from "@/components/employee-photo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { callEndedNotice, callErrorText } from "@/lib/chats/call-logic";
import {
  acceptCall,
  declineCall,
  getActiveCall,
  incomingCallsQuery,
  invalidateCalls,
  leaveCall,
  leaveOnUnload,
  myCallQuery,
  patchActiveCall,
  setActiveCall,
  startCallTone,
  unlockCallAudio,
  useActiveCall,
  type ActiveCall,
  type CallJson,
} from "@/lib/chats/calls";
import { useChatCallsEnabled } from "@/lib/chats/calls-config";
import { usePeople } from "@/lib/chats/people";
import { useRealtimeConnected } from "@/lib/chats/realtime-state";
import { cn } from "@/lib/utils";

const PING_MS = 20_000;

export function CallLayer() {
  const { data: profile } = useStaffProfile();
  const enabled = useChatCallsEnabled();
  const me = profile?.id ?? null;

  // Звук звонка браузер даёт только после нажатия на странице.
  useEffect(() => {
    const unlock = () => unlockCallAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  if (!me || !enabled) return null;
  return (
    <>
      <IncomingCall me={me} />
      <CallWindow me={me} />
    </>
  );
}

/** Подписи звонка: кто звонит / с кем разговор. */
function useCallTitle(
  call: Pick<CallJson, "chat_kind" | "chat_title" | "started_by" | "members">,
  me: string,
) {
  const { name } = usePeople();
  if (call.chat_kind !== "direct") return call.chat_title ?? "Группа";
  const peer =
    call.started_by && call.started_by !== me
      ? call.started_by
      : call.members.find((m) => m.user_id !== me)?.user_id;
  return name(peer);
}

// ---- Входящий ------------------------------------------------------------------

function IncomingCall({ me }: { me: string }) {
  const qc = useQueryClient();
  const live = useRealtimeConnected();
  const active = useActiveCall();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  // Закрыли крестиком — без ответа: не звенит, звонок остаётся в чате.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const { data = [] } = useQuery({
    ...incomingCallsQuery,
    // С Realtime звонок приходит событием; опрос — запасной.
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 5_000 : live ? 30_000 : 4_000),
    refetchOnWindowFocus: true,
  });
  const call = data.find((c) => c.id !== active?.callId && !dismissed.includes(c.id)) ?? null;

  // Звук и мигающий заголовок вкладки, пока звонят.
  const ringing = call?.id ?? null;
  useEffect(() => {
    if (!ringing) return;
    const stop = startCallTone("incoming");
    const title = document.title;
    let on = false;
    const blink = window.setInterval(() => {
      on = !on;
      document.title = on ? "📞 Входящий видеозвонок" : title;
    }, 1000);
    navigator.vibrate?.([400, 200, 400]);
    return () => {
      stop();
      window.clearInterval(blink);
      document.title = title;
    };
  }, [ringing]);

  if (!call) return null;

  const accept = async () => {
    setBusy("accept");
    try {
      await acceptCall(qc, call);
    } catch (e) {
      toast.error(callErrorText(e));
      invalidateCalls(qc, call.chat_id);
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    setBusy("decline");
    qc.setQueryData<CallJson[]>(incomingCallsQuery.queryKey, (list) =>
      (list ?? []).filter((c) => c.id !== call.id),
    );
    try {
      await declineCall(call.id);
    } catch (e) {
      toast.error(callErrorText(e));
    } finally {
      setBusy(null);
      invalidateCalls(qc, call.chat_id);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setDismissed((ids) => [...ids, call.id]);
      }}
    >
      <DialogContent
        // Крестика нет — вместо него явная «Позже» (UI_REVIEW, 3.9).
        className="p-6 sm:max-w-sm [&>button:last-child]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <IncomingBody
          call={call}
          me={me}
          busy={busy}
          onAccept={accept}
          onDecline={decline}
          onLater={() => setDismissed((ids) => [...ids, call.id])}
        />
      </DialogContent>
    </Dialog>
  );
}

function IncomingBody({
  call,
  me,
  busy,
  onAccept,
  onDecline,
  onLater,
}: {
  call: CallJson;
  me: string;
  busy: "accept" | "decline" | null;
  onAccept: () => void;
  onDecline: () => void;
  onLater: () => void;
}) {
  const { name } = usePeople();
  const title = useCallTitle(call, me);
  const caller = name(call.started_by);
  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center">
      <span className="relative">
        <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/40" />
        <ChatAvatar
          chat={{
            id: call.chat_id,
            kind: call.chat_kind,
            peer_id: call.chat_kind === "direct" ? call.started_by : null,
          }}
          title={title}
        />
      </span>
      <div className="space-y-1">
        <DialogTitle className="text-lg">{title}</DialogTitle>
        <DialogDescription>
          {call.chat_kind === "direct" ? "Входящий видеозвонок" : `${caller} начал(а) видеозвонок`}
        </DialogDescription>
      </div>
      <div className="flex w-full gap-3">
        <Button variant="destructive" className="flex-1" disabled={!!busy} onClick={onDecline}>
          {busy === "decline" ? <Loader2 className="animate-spin" /> : <PhoneOff />}
          Отклонить
        </Button>
        <Button
          className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
          disabled={!!busy}
          onClick={onAccept}
          autoFocus
        >
          {busy === "accept" ? <Loader2 className="animate-spin" /> : <Video />}
          Принять
        </Button>
      </div>
      <Button variant="ghost" className="w-full" disabled={!!busy} onClick={onLater}>
        Позже
      </Button>
      <p className="-mt-2 text-xs text-muted-foreground">
        Звонок останется в чате — присоединитесь, пока он идёт.
      </p>
    </div>
  );
}

// ---- Окно звонка ---------------------------------------------------------------

function CallWindow({ me }: { me: string }) {
  const active = useActiveCall();
  if (!active) return null;
  return <CallFrame key={active.callId} active={active} me={me} />;
}

function CallFrame({ active, me }: { active: ActiveCall; me: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { person } = usePeople();
  const [leaving, setLeaving] = useState(false);
  const token = useRef<string | null>(null);
  const { data: call } = useQuery({
    ...myCallQuery(active.callId),
    refetchInterval: PING_MS,
    refetchIntervalInBackground: true,
  });

  // Токен для выхода при закрытии вкладки (запрос без ожидания сессии).
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      token.current = data.session?.access_token ?? null;
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      token.current = session?.access_token ?? null;
    });
    const onHide = () => leaveOnUnload(active.callId, token.current);
    window.addEventListener("pagehide", onHide);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener("pagehide", onHide);
    };
  }, [active.callId]);

  // Звонок окончен или меня в нём уже нет — закрываем окно.
  const ended = !!call && (!!call.ended_at || call.my_state !== "joined");
  useEffect(() => {
    if (!call || !ended) return;
    if (getActiveCall()?.callId !== call.id) return;
    setActiveCall(null);
    const notice = call.ended_at
      ? callEndedNotice(call.end_reason, call.chat_kind, call.started_by === me)
      : null;
    if (notice) toast(notice);
    invalidateCalls(qc, call.chat_id);
  }, [call, ended, me, qc]);

  const others = (call?.members ?? []).filter((m) => m.user_id !== me);
  const inCall = others.filter((m) => m.state === "joined");
  const waiting = !!call && !call.answered_at && others.some((m) => m.state === "ringing");

  // Гудки, пока никто не ответил.
  useEffect(() => {
    if (!waiting || active.external) return;
    return startCallTone("outgoing");
  }, [waiting, active.external]);

  const title = call ? <CallTitle call={call} me={me} /> : "Видеозвонок";
  const status = !call
    ? "Подключение…"
    : waiting && inCall.length === 0
      ? call.chat_kind === "direct"
        ? "Звоним…"
        : "Звоним участникам…"
      : inCall.length
        ? `В звонке: ${inCall.length + 1}`
        : "Ждём участников…";

  const leave = async () => {
    setLeaving(true);
    try {
      const after = await leaveCall(active.callId);
      qc.setQueryData(myCallQuery(active.callId).queryKey, after);
    } catch (e) {
      toast.error(callErrorText(e));
    } finally {
      setActiveCall(null);
      invalidateCalls(qc, active.chatId, active.callId);
    }
  };

  const openExternal = () => {
    window.open(active.link, "_blank", "noopener");
    patchActiveCall({ external: true, minimized: true });
  };

  const min = active.minimized;
  const endLabel = call && call.chat_kind !== "direct" ? "Выйти из звонка" : "Завершить";
  return (
    <div
      role="dialog"
      aria-label="Видеозвонок"
      className={cn(
        "fixed z-50 flex flex-col overflow-hidden bg-neutral-950 text-white shadow-2xl",
        min
          ? cn(
              "right-3 bottom-3 h-56 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl sm:right-5 sm:bottom-5",
              // Телефон: плашка сверху во всю ширину, конференция работает дальше.
              "max-sm:inset-x-0 max-sm:top-0 max-sm:right-0 max-sm:bottom-auto max-sm:h-auto max-sm:w-full max-sm:rounded-none max-sm:bg-emerald-700 max-sm:pt-[env(safe-area-inset-top)]",
            )
          : "inset-0",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 max-sm:gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => navigate({ to: "/chats/$chatId", params: { chatId: active.chatId } })}
          title="Открыть чат"
        >
          {!min && (
            <span className="hidden -space-x-2 sm:flex">
              {inCall.slice(0, 4).map((m) => (
                <StaffAvatar
                  key={m.user_id}
                  value={person(m.user_id)?.avatar_url}
                  name={person(m.user_id)?.full_name ?? ""}
                  className="size-7 text-[10px] ring-2 ring-neutral-950"
                />
              ))}
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">
              {min && <span className="sm:hidden">Идёт звонок · </span>}
              {title}
            </span>
            <span className="block truncate text-xs text-white/60">{status}</span>
          </span>
        </button>
        {min && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white sm:hidden"
            onClick={() => patchActiveCall({ minimized: false, external: false })}
          >
            Вернуться
          </Button>
        )}
        {!active.external && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "text-white hover:bg-white/10 hover:text-white max-sm:size-9",
              min && "max-sm:hidden",
            )}
            aria-label="Открыть в новой вкладке"
            title="Открыть в новой вкладке"
            onClick={openExternal}
          >
            <ExternalLink className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "text-white hover:bg-white/10 hover:text-white max-sm:size-9",
            min && "max-sm:hidden",
          )}
          aria-label={min ? "Развернуть" : "Свернуть"}
          title={min ? "Развернуть" : "Свернуть"}
          onClick={() => patchActiveCall({ minimized: !min })}
        >
          {min ? <Maximize className="size-4" /> : <Minimize className="size-4" />}
        </Button>
        {/* Главная кнопка выхода — наша: красную кнопку Kinescope внутри окна
            скрыть нельзя (чужой сайт), а портал о выходе узнаёт только отсюда
            (решение владельца 2026-11-08). */}
        <Button
          variant="destructive"
          size={min ? "icon" : "default"}
          className={cn("shrink-0", min ? "max-sm:size-9" : "max-sm:h-9 max-sm:px-3")}
          aria-label={endLabel}
          title={endLabel}
          disabled={leaving}
          onClick={() => void leave()}
        >
          {leaving ? <Loader2 className="animate-spin" /> : <PhoneOff />}
          {!min && endLabel}
        </Button>
      </div>
      <div className={cn("relative min-h-0 flex-1 bg-black", min && "max-sm:h-0 max-sm:flex-none")}>
        {active.external ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-white/70">
            <p>Звонок открыт в отдельной вкладке.</p>
            <Button
              variant="outline"
              size="sm"
              className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white"
              onClick={() => patchActiveCall({ external: false })}
            >
              Вернуть сюда
            </Button>
          </div>
        ) : (
          <iframe
            title="Видеоконференция"
            src={active.link}
            className="size-full border-0"
            allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write; speaker-selection"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
}

function CallTitle({ call, me }: { call: CallJson; me: string }) {
  return <>{useCallTitle(call, me)}</>;
}
