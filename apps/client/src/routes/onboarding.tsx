import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Refresh, CheckCircle } from "@solar-icons/react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RulerPicker } from "@/components/ui/ruler-picker";
import {
  OnboardingLoading,
  OptionButton,
  Shell,
  StepActivity,
  StepExperience,
  StepFooter,
  StepHeader,
  StepHealth,
  StepLogistics,
  StepReferral,
  StepTitle,
} from "@/components/onboarding";
import { type Experience, type HealthFlag, type PrefTime, type Referral } from "@/lib/onboarding";
import { queueHomeConfetti } from "@/lib/confetti";
import { PackagesOnboardingPage } from "@/formats/packages/onboarding";
import { Mars, Venus } from "lucide-react";
import { APP_BRAND, IS_PACKAGES } from "@/lib/terms";
import { currentT, getTranslator, msg, useT } from "@/i18n";

export const Route = createFileRoute("/onboarding")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: t("Знакомство — {brand}", { brand: APP_BRAND }) },
        {
          name: "description",
          content: IS_PACKAGES
            ? t("Пара вопросов, чтобы следить за вашим прогрессом.")
            : t("Пара вопросов, чтобы настроить тренировки под вас."),
        },
      ],
    };
  },
  // У пакетного приложения своя анкета (решение владельца 2026-10-11).
  component: IS_PACKAGES ? PackagesOnboardingPage : OnboardingPage,
});

type Gender = "female" | "male" | "other";
type Goal =
  | "weight_loss"
  | "muscle_strength"
  | "endurance"
  | "energy_wellbeing"
  | "stress_habit"
  | "event_prep";
type Timeframe = "no_rush" | "few_months" | "event_date";

type FormData = {
  primary_goal: Goal | null;
  goal_motivation: string;
  target_timeframe: Timeframe | null;
  experience_level: Experience | null;
  current_weekly_activity: number | null;
  tried_group_hiit: boolean | null;
  health_flags: HealthFlag[];
  health_notes: string;
  height_cm: string;
  weight_kg: string;
  birth_year: string;
  gender: Gender | null;
  desired_frequency: number | null;
  preferred_times: PrefTime[];
  referral_source: Referral | null;
};

const EMPTY: FormData = {
  primary_goal: null,
  goal_motivation: "",
  target_timeframe: null,
  experience_level: null,
  current_weekly_activity: null,
  tried_group_hiit: null,
  health_flags: [],
  health_notes: "",
  height_cm: "",
  weight_kg: "",
  birth_year: "",
  gender: null,
  desired_frequency: null,
  preferred_times: [],
  referral_source: null,
};

const TOTAL_STEPS = 10;

function buildPayload(form: FormData) {
  const num = (s: string) => {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) && s.trim() !== "" ? n : null;
  };
  return {
    primary_goal: form.primary_goal,
    goal_motivation: form.goal_motivation.trim() || null,
    target_timeframe: form.target_timeframe,
    experience_level: form.experience_level,
    current_weekly_activity: form.current_weekly_activity,
    tried_group_hiit: form.tried_group_hiit,
    health_flags: form.health_flags,
    health_notes: form.health_notes.trim() || null,
    height_cm: num(form.height_cm),
    weight_kg: num(form.weight_kg),
    birth_year: num(form.birth_year),
    gender: form.gender,
    desired_frequency: form.desired_frequency,
    preferred_times: form.preferred_times,
    referral_source: form.referral_source,
  };
}

function OnboardingPage() {
  const t = useT();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0); // 0=intro, 1..10 steps, 11=final
  const [form, setForm] = useState<FormData>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Load existing draft (if user returns mid-onboarding)
  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("member_profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      // Та же причина, что и в гейте: при ошибке нельзя показывать пустую
      // анкету — сохранение затрёт реальные ответы.
      if (error) {
        // Язык на момент ошибки; в зависимости эффекта t не берём — смена
        // языка не должна перезагружать анкету.
        const t = currentT();
        toast.error(t("Не удалось загрузить анкету. Обновите страницу."));
        return;
      }
      if (data) {
        if (data.onboarding_completed_at) {
          navigate({ to: "/", replace: true });
          return;
        }
        // В БД поля анкеты хранятся как text; локальные юнионы (Goal и т.д.) —
        // клиентское сужение, поэтому на границе нужен явный каст.
        setForm({
          primary_goal: (data.primary_goal as Goal | null) ?? null,
          goal_motivation: data.goal_motivation ?? "",
          target_timeframe: (data.target_timeframe as Timeframe | null) ?? null,
          experience_level: (data.experience_level as Experience | null) ?? null,
          current_weekly_activity: data.current_weekly_activity ?? null,
          tried_group_hiit: data.tried_group_hiit ?? null,
          health_flags: (data.health_flags as HealthFlag[] | null) ?? [],
          health_notes: data.health_notes ?? "",
          height_cm: data.height_cm != null ? String(data.height_cm) : "",
          weight_kg: data.weight_kg != null ? String(data.weight_kg) : "",
          birth_year: data.birth_year != null ? String(data.birth_year) : "",
          gender: (data.gender as Gender | null) ?? null,
          desired_frequency: data.desired_frequency ?? null,
          preferred_times: (data.preferred_times as PrefTime[] | null) ?? [],
          referral_source: (data.referral_source as Referral | null) ?? null,
        });
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

    // Пол и год рождения переносим в карточку клиента, чтобы они появились в
    // профиле, — один раз при завершении и только в пустые поля. Раньше это
    // делалось на каждом шаге и безусловно: точная дата рождения из карточки
    // (её мог внести администратор или сам клиент) заменялась на 1 января.
    if (extra?.onboarding_completed_at) {
      if (form.gender) {
        await supabase
          .from("clients")
          .update({ gender: form.gender })
          .eq("user_id", user.id)
          .is("gender", null);
      }
      const yr = Number(form.birth_year);
      if (Number.isFinite(yr) && yr > 1900) {
        await supabase
          .from("clients")
          .update({ birthday: `${yr}-01-01` })
          .eq("user_id", user.id)
          .is("birthday", null);
      }
    }

    return true;
  }

  async function goNext(nextStep: number) {
    setSaving(true);
    const ok = await persist();
    setSaving(false);
    if (ok) setStep(nextStep);
  }

  async function finish() {
    setSaving(true);
    const ok = await persist({ onboarding_completed_at: new Date().toISOString() });
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
        return !!form.primary_goal;
      case 4:
        return !!form.experience_level;
      case 5:
        return form.current_weekly_activity !== null;
      case 7:
        return form.health_flags.length > 0;
      case 8:
        return form.weight_kg.trim() !== "" && form.birth_year.trim() !== "" && !!form.gender;
      default:
        return true;
    }
  }, [step, form]);

  if (authLoading || (!bootstrapped && user)) {
    return <OnboardingLoading />;
  }

  if (step === 0) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col justify-center px-6 text-center">
          <h1 className="text-3xl font-semibold leading-tight">
            {t("Пара вопросов — и мы подстроим тренировки под вас")}
          </h1>
          <p className="mt-4 text-base text-muted-foreground">
            {t(
              "Это займёт около 2 минут. Поможет тренеру подобрать правильную нагрузку с первого занятия.",
            )}
          </p>
        </div>
        <div className="px-6 pb-8 pt-4">
          <Button className="w-full" onClick={() => setStep(1)}>
            {t("Начать")}
          </Button>
        </div>
      </Shell>
    );
  }

  if (step > TOTAL_STEPS) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="h-16 w-16 rounded-full bg-primary flex items-center justify-center mb-6">
            <CheckCircle className="h-9 w-9 text-primary-foreground" weight="BoldDuotone" />
          </div>
          <h1 className="text-2xl font-semibold leading-tight">
            {t("Готово. Подготовим ваше первое занятие под вас.")}
          </h1>
          <p className="mt-3 text-base text-muted-foreground">{t("До встречи в студии.")}</p>
        </div>
        <div className="px-6 pb-8 pt-4">
          <Button className="w-full" onClick={finish} disabled={saving}>
            {saving ? (
              <Refresh className="h-5 w-5 animate-spin" weight="BoldDuotone" />
            ) : (
              t("Начать")
            )}
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <StepHeader
        step={step}
        total={TOTAL_STEPS}
        onBack={() => setStep((s) => Math.max(0, s - 1))}
      />

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col justify-center [&>*]:w-full">
        {step === 1 && (
          <StepGoal value={form.primary_goal} onChange={(v) => update("primary_goal", v)} />
        )}
        {step === 2 && (
          <StepMotivation
            value={form.goal_motivation}
            onChange={(v) => update("goal_motivation", v)}
          />
        )}
        {step === 3 && (
          <StepTimeframe
            value={form.target_timeframe}
            onChange={(v) => update("target_timeframe", v)}
          />
        )}
        {step === 4 && (
          <StepExperience
            value={form.experience_level}
            onChange={(v) => update("experience_level", v)}
          />
        )}
        {step === 5 && (
          <StepActivity
            value={form.current_weekly_activity}
            onChange={(v) => update("current_weekly_activity", v)}
          />
        )}
        {step === 6 && (
          <StepGroup
            value={form.tried_group_hiit}
            onChange={(v) => update("tried_group_hiit", v)}
          />
        )}
        {step === 7 && (
          <StepHealth
            flags={form.health_flags}
            notes={form.health_notes}
            onFlagsChange={(v) => update("health_flags", v)}
            onNotesChange={(v) => update("health_notes", v)}
          />
        )}
        {step === 8 && (
          <StepBody
            weight={form.weight_kg}
            birthYear={form.birth_year}
            gender={form.gender}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          />
        )}
        {step === 9 && (
          <StepLogistics
            frequency={form.desired_frequency}
            times={form.preferred_times}
            onFreqChange={(v) => update("desired_frequency", v)}
            onTimesChange={(v) => update("preferred_times", v)}
          />
        )}
        {step === 10 && (
          <StepReferral
            value={form.referral_source}
            onChange={(v) => update("referral_source", v)}
          />
        )}
      </div>

      <StepFooter
        disabled={!stepValid}
        saving={saving}
        last={step === TOTAL_STEPS}
        onNext={() => goNext(step + 1)}
      />
    </Shell>
  );
}

/* ===== Steps ===== */

const GOAL_OPTS: { v: Goal; label: string }[] = [
  { v: "weight_loss", label: msg("Снизить вес") },
  { v: "muscle_strength", label: msg("Стать сильнее, набрать мышцы") },
  { v: "endurance", label: msg("Поднять выносливость и форму") },
  { v: "energy_wellbeing", label: msg("Больше энергии и хорошее самочувствие") },
  { v: "stress_habit", label: msg("Снять стресс, выработать привычку") },
  { v: "event_prep", label: msg("Подготовиться к событию") },
];

function StepGoal({ value, onChange }: { value: Goal | null; onChange: (v: Goal) => void }) {
  const t = useT();
  return (
    <div>
      <StepTitle title={t("Что для вас главное прямо сейчас?")} />
      <div className="space-y-2">
        {GOAL_OPTS.map((o) => (
          <OptionButton key={o.v} active={value === o.v} onClick={() => onChange(o.v)}>
            {t(o.label)}
          </OptionButton>
        ))}
      </div>
    </div>
  );
}

function StepMotivation({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <div>
      <StepTitle
        title={t("Что вас к этому подтолкнуло?")}
        subtitle={t("Можно в двух словах — это поможет нам лучше понять вас.")}
      />
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("Например: хочу чувствовать себя бодрее по утрам")}
        rows={5}
        className="resize-none"
      />
    </div>
  );
}

const TIMEFRAME_OPTS: { v: Timeframe; label: string }[] = [
  { v: "no_rush", label: msg("Без спешки, в удовольствие") },
  { v: "few_months", label: msg("Хочу результат за 1–3 месяца") },
  { v: "event_date", label: msg("Готовлюсь к конкретной дате") },
];

function StepTimeframe({
  value,
  onChange,
}: {
  value: Timeframe | null;
  onChange: (v: Timeframe) => void;
}) {
  const t = useT();
  return (
    <div>
      <StepTitle title={t("Есть ли у вас срок?")} />
      <div className="space-y-2">
        {TIMEFRAME_OPTS.map((o) => (
          <OptionButton key={o.v} active={value === o.v} onClick={() => onChange(o.v)}>
            {t(o.label)}
          </OptionButton>
        ))}
      </div>
    </div>
  );
}

function StepGroup({ value, onChange }: { value: boolean | null; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <div>
      <StepTitle title={t("Тренировались в групповом формате?")} />
      <div className="space-y-2">
        <OptionButton active={value === true} onClick={() => onChange(true)}>
          {t("Да, формат знаком")}
        </OptionButton>
        <OptionButton active={value === false} onClick={() => onChange(false)}>
          {t("Нет, будет впервые")}
        </OptionButton>
      </div>
    </div>
  );
}

function StepBody({
  weight,
  birthYear,
  gender,
  onChange,
}: {
  weight: string;
  birthYear: string;
  gender: Gender | null;
  onChange: (patch: Partial<FormData>) => void;
}) {
  const t = useT();
  const currentYear = new Date().getFullYear();
  const weightNum = weight ? Number(weight.replace(",", ".")) : null;
  const yearNum = birthYear ? Number(birthYear) : null;
  return (
    <div>
      <StepTitle
        title={t("Базовые параметры — чтобы правильно рассчитать статистику")}
        subtitle={
          IS_PACKAGES
            ? t("Эти данные увидите только вы и тренеры студии.")
            : t("Эти данные увидите только вы и тренеры клуба.")
        }
      />
      <div className="space-y-7">
        <div>
          <Label className="text-sm block text-center mb-3">{t("Вес")}</Label>
          <RulerPicker
            min={30}
            max={200}
            value={weightNum}
            onChange={(v) => onChange({ weight_kg: String(v) })}
            unit={t("кг")}
          />
        </div>

        <div>
          <Label className="text-sm block text-center mb-3">{t("Год рождения")}</Label>
          <RulerPicker
            min={1940}
            max={currentYear - 5}
            value={yearNum}
            onChange={(v) => onChange({ birth_year: String(v) })}
            tickWidth={14}
            majorEvery={5}
          />
        </div>

        <div>
          <Label className="text-sm block text-center mb-3">{t("Пол")}</Label>
          <div className="grid grid-cols-2 gap-3 max-w-[320px] mx-auto">
            {[
              { v: "female" as Gender, label: t("Женский"), Icon: Venus },
              { v: "male" as Gender, label: t("Мужской"), Icon: Mars },
            ].map(({ v, label, Icon }) => {
              const active = gender === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => onChange({ gender: v })}
                  className={`aspect-square flex flex-col items-center justify-center gap-3 rounded-xl border transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card border-border hover:border-foreground/30"
                  }`}
                >
                  <Icon className="h-10 w-10" strokeWidth={2} />
                  <span className={`text-base ${active ? "font-bold" : "font-medium"}`}>
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
