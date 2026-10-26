import { useNavigate } from "@tanstack/react-router";
import { Children, useEffect, useMemo, useState, type ReactNode } from "react";
import { AltArrowLeft, Refresh } from "@solar-icons/react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RulerPicker } from "@/components/ui/ruler-picker";
import { Textarea } from "@/components/ui/textarea";
import { DarkFrame as Frame, DarkSplash } from "@/formats/packages/dark-frame";
import introArt from "@/assets/onboarding-intro.webp";
import finalArt from "@/assets/onboarding-final.webp";
import scheduleArt from "@/assets/onboarding-schedule.webp";
import {
  ActivityOptions,
  ExperienceOptions,
  FrequencyPicker,
  HealthNotesInput,
  HealthOptions,
  OptionButton,
  ReferralOptions,
  TimesPicker,
} from "@/components/onboarding";
import {
  FREQUENCY_LABEL,
  HEALTH_NOTES_LABEL,
  STEP_TITLES,
  TIMES_LABEL,
  hasHealthIssues,
  type Experience,
  type HealthFlag,
  type PrefTime,
  type Referral,
} from "@/lib/onboarding";
import { queueHomeConfetti } from "@/lib/confetti";
import { IS_PACKAGES } from "@/lib/terms";
import { currentT, msg, useT } from "@/i18n";
import { untypedDb } from "@/lib/untyped-db";
import { PhoneInput } from "@/components/ui/phone-input";
import { isValidPhone } from "@/lib/phone";

// Анкета приложения пакетных студий (решение владельца 2026-10-11). Тренировки
// в этих студиях одни для всех, поэтому анкета — про прогресс и рекомендации
// тренеров, а не про подстройку занятий. Отличия от подписочной: свои цели
// (+ «Другое» с текстом — goal_other), без мотивации, срока и вопроса про
// групповой формат, дата рождения вместо года, пол не спрашиваем — в пакетных
// студиях все клиентки (gender = 'female'). Схема —
// db/migrations/2026-10-11_packages_onboarding.sql.

type Goal = "flexibility" | "stress_relief" | "body_shape" | "other";

const GOALS: { v: Goal; label: string }[] = [
  { v: "flexibility", label: msg("Стать гибче") },
  { v: "stress_relief", label: msg("Снять напряжение и стресс") },
  { v: "body_shape", label: msg("Подтянуть фигуру") },
  { v: "other", label: msg("Другое") },
];

type FormData = {
  primary_goal: Goal | null;
  goal_other: string;
  experience_level: Experience | null;
  current_weekly_activity: number | null;
  health_flags: HealthFlag[];
  health_notes: string;
  weight_kg: string;
  birth_date: string; // YYYY-MM-DD
  desired_frequency: number | null;
  preferred_times: PrefTime[];
  referral_source: Referral | null;
  // Последний шаг — карточка клиента (clients), не анкета: подставляются из
  // карточки, при переходе дальше пишутся в неё.
  last_name: string;
  first_name: string;
  phone: string;
};

// Вес по умолчанию на линейке — 65 кг (решение владельца 2026-10-13): раньше
// линейка вставала на середину шкалы (115 кг).
const DEFAULT_WEIGHT_KG = "65";

const EMPTY: FormData = {
  primary_goal: null,
  goal_other: "",
  experience_level: null,
  current_weekly_activity: null,
  health_flags: [],
  health_notes: "",
  weight_kg: DEFAULT_WEIGHT_KG,
  birth_date: "",
  desired_frequency: null,
  preferred_times: [],
  referral_source: null,
  last_name: "",
  first_name: "",
  phone: "",
};

const TOTAL_STEPS = 8;
const GOAL_OTHER_MAX = 500;
const BIRTH_MIN = "1940-01-01";

/** Самая поздняя дата рождения — пять лет назад (как у линейки года). */
function birthMax() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

function validBirthDate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= BIRTH_MIN && s <= birthMax();
}

/** Телефон заполнен, если в нём хотя бы 7 цифр. */
/** Имя и фамилия из full_name, если в карточке нет раздельных («Фамилия Имя»). */
function splitFullName(full: string | null | undefined) {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { last: "", first: parts[0] ?? "" };
  return { last: parts[0], first: parts.slice(1).join(" ") };
}

function buildPayload(form: FormData) {
  const weight = Number(form.weight_kg.replace(",", "."));
  const birth = validBirthDate(form.birth_date) ? form.birth_date : null;
  return {
    primary_goal: form.primary_goal,
    goal_other: form.primary_goal === "other" ? form.goal_other.trim() || null : null,
    experience_level: form.experience_level,
    current_weekly_activity: form.current_weekly_activity,
    health_flags: form.health_flags,
    health_notes: form.health_notes.trim() || null,
    weight_kg: form.weight_kg.trim() !== "" && Number.isFinite(weight) ? weight : null,
    birth_date: birth,
    // Год — для статистики и прежних мест, где читается birth_year.
    birth_year: birth ? Number(birth.slice(0, 4)) : null,
    gender: "female",
    desired_frequency: form.desired_frequency,
    preferred_times: form.preferred_times,
    referral_source: form.referral_source,
  };
}

export function PackagesOnboardingPage() {
  const t = useT();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0); // 0=intro, 1..7 steps, 8=final
  const [form, setForm] = useState<FormData>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Черновик (клиент вернулся посреди анкеты); дату рождения, если её ещё
  // нет в анкете, подставляем из карточки клиента.
  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    (async () => {
      const [profileRes, clientRes] = await Promise.all([
        supabase.from("member_profiles").select("*").eq("user_id", user.id).maybeSingle(),
        supabase
          .from("clients")
          .select("birthday, first_name, last_name, full_name, phone")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      // Как в гейте: при ошибке нельзя показывать пустую анкету — сохранение
      // затрёт реальные ответы.
      if (profileRes.error) {
        // Язык на момент ошибки; в зависимости эффекта t не берём — смена
        // языка не должна перезагружать анкету.
        const t = currentT();
        toast.error(t("Не удалось загрузить анкету. Обновите страницу."));
        return;
      }
      const data = profileRes.data;
      if (data?.onboarding_completed_at) {
        navigate({ to: "/", replace: true });
        return;
      }
      const card = clientRes.data;
      const cardBirthday = card?.birthday?.slice(0, 10) ?? "";
      const split = splitFullName(card?.full_name);
      const contacts = {
        last_name: card?.last_name ?? split.last,
        first_name: card?.first_name ?? split.first,
        phone: card?.phone ?? "",
      };
      if (data) {
        // В БД поля анкеты — text/enum; локальные юнионы — клиентское сужение.
        const goal = GOALS.some((g) => g.v === data.primary_goal)
          ? (data.primary_goal as Goal)
          : null;
        setForm({
          primary_goal: goal,
          goal_other: data.goal_other ?? "",
          experience_level: (data.experience_level as Experience | null) ?? null,
          current_weekly_activity: data.current_weekly_activity ?? null,
          health_flags: (data.health_flags as HealthFlag[] | null) ?? [],
          health_notes: data.health_notes ?? "",
          weight_kg: data.weight_kg != null ? String(data.weight_kg) : DEFAULT_WEIGHT_KG,
          birth_date: data.birth_date ?? cardBirthday,
          desired_frequency: data.desired_frequency ?? null,
          preferred_times: (data.preferred_times as PrefTime[] | null) ?? [],
          referral_source: (data.referral_source as Referral | null) ?? null,
          ...contacts,
        });
      } else {
        setForm((f) => ({ ...f, birth_date: cardBirthday, ...contacts }));
      }
      setBootstrapped(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading, navigate]);

  const update = <K extends keyof FormData>(key: K, value: FormData[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function persist(extra?: Partial<{ onboarding_completed_at: string | null }>) {
    if (!user) return false;
    const payload = { user_id: user.id, ...buildPayload(form), ...extra };
    const { error } = await supabase
      .from("member_profiles")
      .upsert(payload, { onConflict: "user_id" });
    if (error) {
      toast.error(t("Не удалось сохранить: {error}", { error: error.message }));
      return false;
    }

    // В карточку клиента — при завершении. Дату рождения клиентка указала
    // целиком (подставлена из карточки, если там была), поэтому пишем её;
    // пол — только в пустое поле.
    if (extra?.onboarding_completed_at) {
      if (validBirthDate(form.birth_date)) {
        await supabase.from("clients").update({ birthday: form.birth_date }).eq("user_id", user.id);
      }
      await supabase
        .from("clients")
        .update({ gender: "female" })
        .eq("user_id", user.id)
        .is("gender", null);
    }

    return true;
  }

  /** Фамилия, имя и телефон — в карточку клиента (её видит студия на портале). */
  async function saveContacts() {
    if (!user) return false;
    const last = form.last_name.trim();
    const first = form.first_name.trim();
    const { error } = await supabase
      .from("clients")
      .update({
        last_name: last,
        first_name: first,
        full_name: `${last} ${first}`,
        phone: form.phone.trim(),
      })
      .eq("user_id", user.id);
    if (error) {
      toast.error(t("Не удалось сохранить данные: {error}", { error: error.message }));
      return false;
    }
    return true;
  }

  async function goNext(nextStep: number) {
    setSaving(true);
    const ok = (await persist()) && (step !== CONTACTS_STEP || (await saveContacts()));
    setSaving(false);
    if (ok) setStep(nextStep);
  }

  async function finish() {
    setSaving(true);
    const completedAt = new Date().toISOString();
    const ok = await persist({ onboarding_completed_at: completedAt });
    // Вес из анкеты — первая запись истории веса, датой отправки
    // (client_weights; повторная запись «onboarding» не создастся — 23505).
    // Сбой не мешает завершить анкету: вес остаётся и в самой анкете.
    if (ok && user) {
      const weight = Number(form.weight_kg.replace(",", "."));
      if (Number.isFinite(weight) && weight >= 20 && weight <= 300) {
        const { error } = await untypedDb.from("client_weights").insert({
          user_id: user.id,
          weight_kg: weight,
          measured_at: completedAt,
          source: "onboarding",
        });
        if (error && error.code !== "23505") console.warn("client_weights:", error.message);
      }
    }
    setSaving(false);
    if (ok) {
      // Анкета пройдена — на главную, там салют.
      queueHomeConfetti();
      toast.success(t("Анкета сохранена"));
      navigate({ to: "/", replace: true });
    }
  }

  const stepValid = useMemo(() => {
    switch (step) {
      case 1:
        return (
          !!form.primary_goal && (form.primary_goal !== "other" || form.goal_other.trim() !== "")
        );
      case 2:
        return !!form.experience_level;
      case 3:
        return form.current_weekly_activity !== null;
      case 4:
        return form.health_flags.length > 0;
      case 5:
        return form.weight_kg.trim() !== "" && validBirthDate(form.birth_date);
      case CONTACTS_STEP:
        return (
          form.last_name.trim() !== "" && form.first_name.trim() !== "" && isValidPhone(form.phone)
        );
      default:
        return true;
    }
  }, [step, form]);

  if (authLoading || (!bootstrapped && user)) {
    return <DarkSplash />;
  }

  if (step === 0) {
    return (
      <Frame
        tall
        art={introArt}
        header={
          <div className="px-6 pt-2 pb-10">
            <h1 className="text-3xl font-semibold leading-tight">
              {t("Пара вопросов — и вы сможете следить за своим прогрессом")}
            </h1>
          </div>
        }
        footer={<PrimaryButton onClick={() => setStep(1)}>{t("Начать")}</PrimaryButton>}
      >
        <p className="px-6 pt-6 text-base text-muted-foreground">
          {t(
            "Это займёт около 2 минут. Ответы помогут отслеживать ваш прогресс, а нашим тренерам — давать вам рекомендации.",
          )}
        </p>
      </Frame>
    );
  }

  if (step > TOTAL_STEPS) {
    return (
      <Frame
        tall
        art={finalArt}
        header={
          <div className="px-6 pt-2 pb-10">
            <h1 className="text-3xl font-semibold leading-tight">
              {t("Спасибо, что поделились с нами!")}
            </h1>
          </div>
        }
        footer={
          <PrimaryButton onClick={finish} disabled={saving} saving={saving}>
            {t("Начать")}
          </PrimaryButton>
        }
      >
        <p className="px-6 pt-6 text-base text-muted-foreground">
          {t("Теперь вы сможете следить за своим прогрессом — ждём вас на тренировке в студии!")}
        </p>
      </Frame>
    );
  }

  const titles = STEP_HEADERS[step];
  const art = STEP_ART[step];

  return (
    <Frame
      tall={!!art || step === CONTACTS_STEP}
      art={art}
      top={
        <div className="px-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 transition-colors active:bg-white/20"
              aria-label={t("Назад")}
            >
              <AltArrowLeft className="h-5 w-5" weight="BoldDuotone" />
            </button>
            <Progress step={step} total={TOTAL_STEPS} />
          </div>
        </div>
      }
      header={
        <div className="px-4 pt-5 pb-8">
          <h1 className="text-2xl font-semibold leading-tight">{t(titles.title)}</h1>
          {titles.subtitle && (
            <p className="frame-hide-typing mt-2 text-sm text-white/70">{t(titles.subtitle)}</p>
          )}
        </div>
      }
      footer={
        <PrimaryButton
          onClick={() => goNext(step + 1)}
          disabled={!stepValid || saving}
          saving={saving}
        >
          {step === TOTAL_STEPS ? t("Завершить") : t("Далее")}
        </PrimaryButton>
      }
    >
      {step === 1 && (
        <Blocks>
          <Block>
            <GoalOptions value={form.primary_goal} onChange={(v) => update("primary_goal", v)} />
          </Block>
          {form.primary_goal === "other" && (
            <Block title={t("Расскажите, чего хотите добиться")}>
              <Textarea
                value={form.goal_other}
                onChange={(e) => update("goal_other", e.target.value)}
                maxLength={GOAL_OTHER_MAX}
                rows={3}
                className="resize-none"
                aria-label={t("Расскажите, чего хотите добиться")}
                autoFocus
              />
            </Block>
          )}
        </Blocks>
      )}
      {step === 2 && (
        <Blocks>
          <Block>
            <ExperienceOptions
              value={form.experience_level}
              onChange={(v) => update("experience_level", v)}
            />
          </Block>
        </Blocks>
      )}
      {step === 3 && (
        <Blocks>
          <Block>
            <ActivityOptions
              value={form.current_weekly_activity}
              onChange={(v) => update("current_weekly_activity", v)}
            />
          </Block>
        </Blocks>
      )}
      {step === 4 && (
        <Blocks>
          <Block>
            <HealthOptions flags={form.health_flags} onChange={(v) => update("health_flags", v)} />
          </Block>
          {hasHealthIssues(form.health_flags) && (
            <Block title={t(HEALTH_NOTES_LABEL)}>
              <HealthNotesInput
                value={form.health_notes}
                onChange={(v) => update("health_notes", v)}
              />
            </Block>
          )}
        </Blocks>
      )}
      {step === 5 && (
        <Blocks>
          <Block title={t("Вес")}>
            <RulerPicker
              min={30}
              max={200}
              value={form.weight_kg ? Number(form.weight_kg.replace(",", ".")) : null}
              onChange={(v) => update("weight_kg", String(v))}
              unit={t("кг")}
            />
          </Block>
          <Block title={t("Дата рождения")}>
            <BirthDateInput value={form.birth_date} onChange={(v) => update("birth_date", v)} />
          </Block>
        </Blocks>
      )}
      {step === 6 && (
        <Blocks>
          <Block title={t(FREQUENCY_LABEL)}>
            <FrequencyPicker
              value={form.desired_frequency}
              onChange={(v) => update("desired_frequency", v)}
            />
          </Block>
          <Block title={t(TIMES_LABEL)}>
            <TimesPicker
              value={form.preferred_times}
              onChange={(v) => update("preferred_times", v)}
            />
          </Block>
        </Blocks>
      )}
      {step === 7 && (
        <Blocks>
          <Block>
            <ReferralOptions
              value={form.referral_source}
              onChange={(v) => update("referral_source", v)}
            />
          </Block>
        </Blocks>
      )}
      {step === CONTACTS_STEP && (
        <Blocks>
          <Block>
            <div className="space-y-4">
              <ContactField
                id="last_name"
                label={t("Фамилия")}
                value={form.last_name}
                onChange={(v) => update("last_name", v)}
                autoComplete="family-name"
              />
              <ContactField
                id="first_name"
                label={t("Имя")}
                value={form.first_name}
                onChange={(v) => update("first_name", v)}
                autoComplete="given-name"
              />
              <div className="space-y-1.5">
                <Label htmlFor="phone">{t("Номер телефона")}</Label>
                <PhoneInput
                  id="phone"
                  value={form.phone}
                  onChange={(v) => update("phone", v)}
                  className="h-12"
                />
              </div>
            </div>
          </Block>
        </Blocks>
      )}
    </Frame>
  );
}

/**
 * Иллюстрации шагов, где мало полей (на шагах со списками их нет): шаг
 * становится tall — картинка в тёмной зоне, белая панель по содержимому.
 */
const STEP_ART: Record<number, string> = {
  6: scheduleArt,
};

/** Вопрос шага — в тёмной шапке. */
const STEP_HEADERS: Record<number, { title: string; subtitle?: string }> = {
  1: { title: msg("Что для вас главное прямо сейчас?") },
  2: STEP_TITLES.experience,
  3: STEP_TITLES.activity,
  4: STEP_TITLES.health,
  5: {
    title: msg("Базовые параметры — чтобы правильно рассчитать статистику"),
    subtitle: IS_PACKAGES
      ? msg("Эти данные увидите только вы и тренеры студии.")
      : msg("Эти данные увидите только вы и тренеры клуба."),
  },
  6: STEP_TITLES.logistics,
  7: STEP_TITLES.referral,
  8: {
    title: msg("Последний шаг — заполните свои данные"),
    subtitle: IS_PACKAGES
      ? msg(
          "Фамилия, имя и номер телефона — чтобы администратор студии мог с вами связаться. Что уже есть в студии, мы подставили.",
        )
      : msg(
          "Фамилия, имя и номер телефона — чтобы администратор клуба мог с вами связаться. Что уже есть в клубе, мы подставили.",
        ),
  },
};

/** Шаг с фамилией, именем и телефоном — последний перед «Спасибо». */
const CONTACTS_STEP = 8;

/** Прогресс анкеты: «Шаг N из M» и полоска по шагам. */
function Progress({ step, total }: { step: number; total: number }) {
  const t = useT();
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 text-xs font-semibold text-white/70 tabular-nums">
        {t("Шаг {step} из {total}", { step, total })}
      </div>
      <div className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
              i < step ? "bg-white" : "bg-white/20"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Смысловые блоки шага с разделителями, как на главной: серая полоса между
 * белыми блоками со скруглёнными краями. Первый блок примыкает к верху
 * панели, последний — к кнопке.
 */
function Blocks({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <div className="bg-muted">
      {items.map((child, i) => {
        const first = i === 0;
        const last = i === items.length - 1;
        return (
          <div
            key={i}
            className={`bg-background ${first ? "" : "mt-3 rounded-t-[14px]"} ${
              last ? "" : "rounded-b-[14px]"
            }`}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}

function Block({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="px-4 pt-5 pb-5">
      {title && <h2 className="mb-3 text-lg font-semibold leading-tight">{title}</h2>}
      {children}
    </section>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  saving,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  saving?: boolean;
  children: ReactNode;
}) {
  return (
    <Button className="w-full" onClick={onClick} disabled={disabled}>
      {saving ? <Refresh className="h-5 w-5 animate-spin" weight="BoldDuotone" /> : children}
    </Button>
  );
}

function GoalOptions({ value, onChange }: { value: Goal | null; onChange: (v: Goal) => void }) {
  const t = useT();
  return (
    <div className="space-y-2">
      {GOALS.map((o) => (
        <OptionButton key={o.v} active={value === o.v} onClick={() => onChange(o.v)}>
          {t(o.label)}
        </OptionButton>
      ))}
    </div>
  );
}

function ContactField({
  id,
  label,
  value,
  onChange,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
} & Pick<React.ComponentProps<"input">, "autoComplete" | "type" | "inputMode">) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={60}
        // Запас при докрутке к полю в фокусе — не прилипает к краю панели.
        className="h-12 scroll-my-6 text-base"
        {...rest}
      />
    </div>
  );
}

function BirthDateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const invalid = value !== "" && !validBirthDate(value);
  return (
    <div>
      <Input
        type="date"
        value={value}
        min={BIRTH_MIN}
        max={birthMax()}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("Дата рождения")}
        className="text-base font-semibold"
      />
      {invalid && <p className="mt-2 text-xs text-destructive">{t("Проверьте дату рождения")}</p>}
    </div>
  );
}
