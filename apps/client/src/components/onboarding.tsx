import { AltArrowLeft, Refresh } from "@solar-icons/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { msg, useT } from "@/i18n";
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

// Общее для анкет обоих приложений: подписочного (src/routes/onboarding.tsx)
// и пакетного (src/formats/packages/onboarding.tsx). Ответы — member_profiles.

export function OnboardingLoading() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center">
      <Refresh className="h-6 w-6 text-muted-foreground animate-spin" weight="BoldDuotone" />
    </div>
  );
}

/** Шапка шага: «Назад» и прогресс «N/всего». */
export function StepHeader({
  step,
  total,
  onBack,
}: {
  step: number;
  total: number;
  onBack: () => void;
}) {
  const t = useT();
  const progress = (step / total) * 100;
  return (
    <div className="px-4 pt-3 pb-2">
      <div className="flex items-center gap-3 mb-3">
        <button
          type="button"
          onClick={onBack}
          className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-muted transition-colors"
          aria-label={t("Назад")}
        >
          <AltArrowLeft className="h-5 w-5" weight="BoldDuotone" />
        </button>
        <div className="flex-1">
          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {step}/{total}
        </span>
      </div>
    </div>
  );
}

/** Подвал шага: «Далее», на последнем — «Завершить». */
export function StepFooter({
  disabled,
  saving,
  last,
  onNext,
}: {
  disabled: boolean;
  saving: boolean;
  last: boolean;
  onNext: () => void;
}) {
  const t = useT();
  return (
    <div className="px-4 pb-6 pt-2 space-y-2 border-t border-border/40">
      <Button className="w-full" disabled={disabled || saving} onClick={onNext}>
        {saving ? (
          <Refresh className="h-5 w-5 animate-spin" weight="BoldDuotone" />
        ) : last ? (
          t("Завершить")
        ) : (
          t("Далее")
        )}
      </Button>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-[100dvh] bg-background">{children}</div>;
}

/* ===== Reusable controls ===== */

export function OptionButton({
  active,
  soft = false,
  onClick,
  children,
}: {
  active: boolean;
  /**
   * Выбранный — розовая обводка и светло-розовый фон вместо заливки цветом
   * бренда (обратная связь, решение владельца 2026-10-15).
   */
  soft?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-4 rounded-xl border transition-colors ${
        active
          ? soft
            ? "bg-primary/10 text-foreground border-primary ring-1 ring-primary"
            : "bg-primary text-primary-foreground border-primary font-semibold"
          : "bg-card text-card-foreground border-border hover:border-foreground/30"
      }`}
    >
      {children}
    </button>
  );
}

/** Заголовок шага; title и subtitle — уже переведённые строки. */
export function StepTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-2xl font-semibold leading-tight">{title}</h2>
      {subtitle && <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

/* ===== Вопросы =====
   Заголовки (STEP_TITLES, lib/onboarding.ts) и варианты ответов (…Options) — отдельно: в
   подписочной анкете они идут одним блоком (Step…), в пакетной заголовок —
   в тёмной шапке, варианты — в белой панели. */

function ChoiceList<T extends string | number>({
  opts,
  isActive,
  onPick,
}: {
  opts: { v: T; label: string }[];
  isActive: (v: T) => boolean;
  onPick: (v: T) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      {opts.map((o) => (
        <OptionButton key={o.v} active={isActive(o.v)} onClick={() => onPick(o.v)}>
          {t(o.label)}
        </OptionButton>
      ))}
    </div>
  );
}

const EXPERIENCE_OPTS: { v: Experience; label: string }[] = [
  { v: "beginner", label: msg("Новичок или большой перерыв") },
  { v: "occasional", label: msg("Тренируюсь время от времени") },
  { v: "regular", label: msg("Регулярно, 2–3 раза в неделю") },
  { v: "advanced", label: msg("Опытный, тренируюсь интенсивно") },
];

export function ExperienceOptions({
  value,
  onChange,
}: {
  value: Experience | null;
  onChange: (v: Experience) => void;
}) {
  return <ChoiceList opts={EXPERIENCE_OPTS} isActive={(v) => value === v} onPick={onChange} />;
}

const ACTIVITY_OPTS: { v: number; label: string }[] = [
  { v: 0, label: msg("Почти не двигаюсь") },
  { v: 1, label: msg("1 раз в неделю") },
  { v: 3, label: msg("2–3 раза в неделю") },
  { v: 5, label: msg("4 и больше") },
];

export function ActivityOptions({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number) => void;
}) {
  return <ChoiceList opts={ACTIVITY_OPTS} isActive={(v) => value === v} onPick={onChange} />;
}

const HEALTH_OPTS: { v: HealthFlag; label: string }[] = [
  { v: "back_joints", label: msg("Спина или суставы") },
  { v: "cardio_pressure", label: msg("Сердце или давление") },
  { v: "recent_injury", label: msg("Недавняя травма или операция") },
  { v: "pregnancy", label: msg("Беременность") },
  { v: "chronic", label: msg("Хроническое заболевание") },
  { v: "none", label: msg("Ничего из перечисленного") },
];

export function HealthOptions({
  flags,
  onChange,
}: {
  flags: HealthFlag[];
  onChange: (v: HealthFlag[]) => void;
}) {
  const toggle = (f: HealthFlag) => {
    if (f === "none") {
      onChange(["none"]);
      return;
    }
    const next = flags.includes(f)
      ? flags.filter((x) => x !== f)
      : [...flags.filter((x) => x !== "none"), f];
    onChange(next);
  };
  return <ChoiceList opts={HEALTH_OPTS} isActive={(v) => flags.includes(v)} onPick={toggle} />;
}

export function HealthNotesInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <Textarea
      id="health_notes"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t("Необязательно")}
      rows={3}
      className="resize-none"
    />
  );
}

function tileClass(active: boolean) {
  return `h-12 rounded-xl border font-semibold transition-colors ${
    active
      ? "bg-primary text-primary-foreground border-primary"
      : "bg-card border-border hover:border-foreground/30"
  }`;
}

export function FrequencyPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {[1, 2, 3, 4].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={tileClass(value === n)}
        >
          {n === 4 ? "4+" : n}
        </button>
      ))}
    </div>
  );
}

const TIME_OPTS: { v: PrefTime; label: string }[] = [
  { v: "morning", label: msg("Утро") },
  { v: "day", label: msg("День") },
  { v: "evening", label: msg("Вечер") },
];

export function TimesPicker({
  value,
  onChange,
}: {
  value: PrefTime[];
  onChange: (v: PrefTime[]) => void;
}) {
  const t = useT();
  const toggle = (time: PrefTime) =>
    onChange(value.includes(time) ? value.filter((x) => x !== time) : [...value, time]);
  return (
    <div className="grid grid-cols-3 gap-2">
      {TIME_OPTS.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => toggle(o.v)}
          className={tileClass(value.includes(o.v))}
        >
          {t(o.label)}
        </button>
      ))}
    </div>
  );
}

const REFERRAL_OPTS: { v: Referral; label: string }[] = [
  { v: "instagram", label: msg("Instagram / соцсети") },
  { v: "referral", label: msg("Рекомендация друга") },
  { v: "walk_by", label: msg("Проходил(а) мимо") },
  { v: "search", label: msg("Поиск / карты") },
  { v: "other", label: msg("Другое") },
];

export function ReferralOptions({
  value,
  onChange,
}: {
  value: Referral | null;
  onChange: (v: Referral) => void;
}) {
  return <ChoiceList opts={REFERRAL_OPTS} isActive={(v) => value === v} onPick={onChange} />;
}

/* ===== Шаги подписочной анкеты: заголовок + варианты ===== */

/** Заголовок из STEP_TITLES (подписи — msg()) на языке клиента. */
function TitleOf({ step }: { step: keyof typeof STEP_TITLES }) {
  const t = useT();
  const { title, subtitle } = STEP_TITLES[step];
  return <StepTitle title={t(title)} subtitle={subtitle ? t(subtitle) : undefined} />;
}

export function StepExperience(props: {
  value: Experience | null;
  onChange: (v: Experience) => void;
}) {
  return (
    <div>
      <TitleOf step="experience" />
      <ExperienceOptions {...props} />
    </div>
  );
}

export function StepActivity(props: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div>
      <TitleOf step="activity" />
      <ActivityOptions {...props} />
    </div>
  );
}

export function StepHealth({
  flags,
  notes,
  onFlagsChange,
  onNotesChange,
}: {
  flags: HealthFlag[];
  notes: string;
  onFlagsChange: (v: HealthFlag[]) => void;
  onNotesChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <div>
      <TitleOf step="health" />
      <HealthOptions flags={flags} onChange={onFlagsChange} />
      {hasHealthIssues(flags) && (
        <div className="mt-5 space-y-2">
          <Label htmlFor="health_notes">{t(HEALTH_NOTES_LABEL)}</Label>
          <HealthNotesInput value={notes} onChange={onNotesChange} />
        </div>
      )}
    </div>
  );
}

export function StepLogistics({
  frequency,
  times,
  onFreqChange,
  onTimesChange,
}: {
  frequency: number | null;
  times: PrefTime[];
  onFreqChange: (v: number) => void;
  onTimesChange: (v: PrefTime[]) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-6">
      <TitleOf step="logistics" />
      <div>
        <Label className="text-sm">{t(FREQUENCY_LABEL)}</Label>
        <div className="mt-2">
          <FrequencyPicker value={frequency} onChange={onFreqChange} />
        </div>
      </div>
      <div>
        <Label className="text-sm">{t(TIMES_LABEL)}</Label>
        <div className="mt-2">
          <TimesPicker value={times} onChange={onTimesChange} />
        </div>
      </div>
    </div>
  );
}

export function StepReferral(props: { value: Referral | null; onChange: (v: Referral) => void }) {
  return (
    <div>
      <TitleOf step="referral" />
      <ReferralOptions {...props} />
    </div>
  );
}
