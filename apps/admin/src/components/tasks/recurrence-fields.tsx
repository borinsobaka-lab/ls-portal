/**
 * Расписание регулярной задачи — одни и те же поля в «Регулярных», в форме
 * постановки («Повторять») и в карточке («Сделать регулярной»): как часто,
 * дни недели, число месяца, через сколько дней после закрытия, во сколько и
 * «Пропускать, если прежняя не закрыта» (UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 4.9). Правило собирает `buildRule` (lib/tasks/logic.ts).
 */
import { CheckboxOption, FormField, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { TimeField } from "@/components/ui/date-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RECURRENCE_FREQS, type RuleDraft } from "@/lib/tasks/logic";
import type { RecurrenceRule } from "@/lib/tasks/types";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const TIPS = {
  skip: "Задачи не копятся. Выключено — следующая появится, когда закроют прежнюю. Включено — прежняя закроется как пропущенная, и придёт новая.",
};

export function RecurrenceFields({
  draft,
  onDraft,
  time,
  onTime,
  skip,
  onSkip,
  error,
}: {
  draft: RuleDraft;
  onDraft: (d: RuleDraft) => void;
  time: string;
  onTime: (t: string) => void;
  /** «Пропускать, если прежняя не закрыта» (mode = skip); нет — переключателя нет. */
  skip?: boolean;
  onSkip?: (v: boolean) => void;
  error?: string | null;
}) {
  const set = (p: Partial<RuleDraft>) => onDraft({ ...draft, ...p });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <FormField label="Повторять" error={draft.freq === "weekly" ? null : error}>
          <Select
            value={draft.freq}
            onValueChange={(v) => set({ freq: v as RecurrenceRule["freq"] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RECURRENCE_FREQS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Во сколько" hint="По вашему часовому поясу">
          <TimeField value={time} onChange={onTime} className="w-full sm:w-32" />
        </FormField>
      </div>
      {draft.freq === "weekly" && (
        <FormField label="Дни недели" htmlFor={null} error={error}>
          <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border p-3">
            {WEEKDAYS.map((w, i) => (
              <CheckboxOption
                key={w}
                checked={draft.weekdays.includes(i + 1)}
                onCheckedChange={(v) =>
                  set({
                    weekdays: v
                      ? [...draft.weekdays, i + 1].sort()
                      : draft.weekdays.filter((x) => x !== i + 1),
                  })
                }
              >
                {w}
              </CheckboxOption>
            ))}
          </div>
        </FormField>
      )}
      {draft.freq === "monthly" && (
        <FormField label="Число месяца" hint="31 — в последний день месяца, если дней меньше">
          <Input
            type="number"
            min={1}
            max={31}
            value={draft.monthday}
            onChange={(e) => set({ monthday: e.target.value })}
          />
        </FormField>
      )}
      {draft.freq === "after_close" && (
        <FormField
          label="Через сколько дней после закрытия"
          hint="0 — в тот же день, когда закроют прежнюю"
        >
          <Input
            type="number"
            min={0}
            max={365}
            value={draft.afterDays}
            onChange={(e) => set({ afterDays: e.target.value })}
          />
        </FormField>
      )}
      {onSkip && (
        <SwitchRow
          title="Пропускать, если прежняя не закрыта"
          tip={TIPS.skip}
          checked={!!skip}
          onCheckedChange={onSkip}
        />
      )}
    </div>
  );
}
