import { useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxOption, FormField } from "@/components/ui/form-field";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatDate } from "@/lib/format";

export type ActiveMembership = {
  id: string;
  ends_at: string | null;
  visits_left: number | null;
  /** Пакетный клуб: остаток персональных тренировок. */
  personal_left?: number | null;
  /** Пакетный клуб: остаток диагностик тела. */
  diagnostics_left?: number | null;
  status?: string;
  freeze_days_used?: number | null;
  frozen_until?: string | null;
  freeze_days_allowed?: number;
};

type FormProps = {
  onOpenChange: (v: boolean) => void;
  membership: ActiveMembership;
  onSaved: () => void;
  /**
   * Пакетный клуб: два баланса — групповые (visits_left) и персональные
   * (personal_left), правятся отдельно (решение владельца 2026-10-14).
   */
  isPackages?: boolean;
};

export function EditActiveMembershipDialog({
  open,
  onOpenChange,
  membership,
  onSaved,
  isPackages = false,
}: Omit<FormProps, "membership"> & {
  open: boolean;
  membership: ActiveMembership | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Редактировать активный абонемент</DialogTitle>
          <DialogDescription>
            {isPackages
              ? "Срок действия, остаток групповых и персональных тренировок, диагностик, заморозка."
              : "Срок действия, остаток посещений и заморозка."}
          </DialogDescription>
        </DialogHeader>
        {/*
          Форма монтируется заново при каждом открытии — сбрасывать её не нужно,
          а перезагрузка карточки под открытым окном не затирает ввод.
        */}
        {membership && (
          <MembershipForm
            key={membership.id}
            membership={membership}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
            isPackages={isPackages}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MembershipForm({ onOpenChange, membership, onSaved, isPackages }: FormProps) {
  const [endsAt, setEndsAt] = useState(membership.ends_at ?? "");
  const [unlimitedVisits, setUnlimitedVisits] = useState(membership.visits_left == null);
  const [visitsLeft, setVisitsLeft] = useState(
    membership.visits_left != null ? String(membership.visits_left) : "",
  );
  const [personalLeft, setPersonalLeft] = useState(String(membership.personal_left ?? 0));
  const [diagnosticsLeft, setDiagnosticsLeft] = useState(String(membership.diagnostics_left ?? 0));
  const [saving, setSaving] = useState(false);
  const [freezeDaysInput, setFreezeDaysInput] = useState("");
  const [freezing, setFreezing] = useState(false);
  // Сохранение и заморозка — разные запросы к одной записи: пока идёт один,
  // остальные кнопки окна неактивны.
  const busy = saving || freezing;

  const allowed = membership.freeze_days_allowed ?? 0;
  const used = membership.freeze_days_used ?? 0;
  const remaining = Math.max(0, allowed - used);
  const status = membership.status;

  const done = (message: string) => {
    toast.success(message);
    onOpenChange(false);
    onSaved();
  };

  const handleFreeze = async () => {
    const days = Math.floor(Number(freezeDaysInput) || 0);
    if (days <= 0) {
      toast.error("Укажите количество дней");
      return;
    }
    if (days > remaining) {
      toast.error(`Доступно только ${remaining} дн. заморозки`);
      return;
    }
    setFreezing(true);
    try {
      const { error } = await supabase.rpc("freeze_membership", {
        _client_membership_id: membership.id,
        _days: days,
        _reason: null,
      });
      if (error) {
        toast.error("Ошибка заморозки: " + error.message);
        return;
      }
      done("Абонемент заморожен");
    } finally {
      setFreezing(false);
    }
  };

  const handleUnfreeze = async () => {
    setFreezing(true);
    try {
      const { error } = await supabase.rpc("unfreeze_membership", {
        _client_membership_id: membership.id,
      });
      if (error) {
        toast.error("Ошибка разморозки: " + error.message);
        return;
      }
      done("Абонемент разморожен");
    } finally {
      setFreezing(false);
    }
  };

  const handleSave = async () => {
    // null в visits_left — это безлимит. Пустое поле при снятой галочке
    // раньше молча превращало абонемент в безлимитный.
    let visits: number | null = null;
    if (!unlimitedVisits) {
      const n = Number(visitsLeft.trim());
      if (visitsLeft.trim() === "" || !Number.isInteger(n) || n < 0) {
        toast.error("Укажите количество посещений (целое число от 0) или отметьте «Безлимит»");
        return;
      }
      visits = n;
    }
    let personal: number | undefined;
    if (isPackages) {
      const n = Number(personalLeft.trim());
      if (personalLeft.trim() === "" || !Number.isInteger(n) || n < 0) {
        toast.error("Укажите количество персональных тренировок (целое число от 0)");
        return;
      }
      personal = n;
    }
    let diagnostics: number | undefined;
    if (isPackages) {
      const n = Number(diagnosticsLeft.trim());
      if (diagnosticsLeft.trim() === "" || !Number.isInteger(n) || n < 0) {
        toast.error("Укажите количество диагностик (целое число от 0)");
        return;
      }
      diagnostics = n;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("client_memberships")
        .update({
          ends_at: endsAt || null,
          visits_left: visits,
          ...(personal !== undefined ? { personal_left: personal } : {}),
          ...(diagnostics !== undefined ? { diagnostics_left: diagnostics } : {}),
        })
        .eq("id", membership.id)
        .select("id");
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      // RLS не пустил (абонемент клуба другой базы клиентов) — ошибки нет,
      // но и строка не изменилась.
      if (!data?.length) {
        toast.error("Абонемент не сохранён: нет прав в клубе, где его продали");
        return;
      }
      done("Абонемент обновлён");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogForm onSubmit={handleSave}>
      <DialogBody>
        <div className="space-y-4">
          <FormField
            label="Действует до"
            tip="Последний день абонемента. На следующий день он станет истёкшим."
          >
            <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </FormField>
          <FormField
            label={isPackages ? "Групповые тренировки" : "Осталось посещений"}
            required={!unlimitedVisits}
            tip={
              isPackages
                ? "Сколько групповых тренировок осталось. Списываются, когда отмечено посещение группового занятия."
                : "Ручная правка остатка — например, вернуть занятие, отменённое по вине клуба."
            }
          >
            <Input
              type="number"
              min={0}
              value={visitsLeft}
              onChange={(e) => setVisitsLeft(e.target.value)}
              disabled={unlimitedVisits}
              placeholder="Например, 5"
            />
            <CheckboxOption checked={unlimitedVisits} onCheckedChange={setUnlimitedVisits}>
              Безлимит
            </CheckboxOption>
          </FormField>
          {isPackages && (
            <FormField
              label="Персональные тренировки"
              required
              tip="Сколько персональных тренировок осталось (у пакета тренировок — подарочные). Списываются, когда отмечено посещение персонального занятия."
            >
              <Input
                type="number"
                min={0}
                value={personalLeft}
                onChange={(e) => setPersonalLeft(e.target.value)}
                placeholder="Например, 1"
              />
            </FormField>
          )}
          {isPackages && (
            <FormField
              label="Диагностики"
              required
              tip="Сколько диагностик тела осталось. Списываются, когда отмечено посещение диагностики в расписании."
            >
              <Input
                type="number"
                min={0}
                value={diagnosticsLeft}
                onChange={(e) => setDiagnosticsLeft(e.target.value)}
                placeholder="Например, 1"
              />
            </FormField>
          )}

          {/* Блок показываем и при нулевой квоте, если абонемент уже заморожен:
            иначе после обнуления «дней заморозки» в тарифе разморозить его
            стало бы нечем. */}
          {(allowed > 0 || status === "frozen") && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="text-xs font-medium uppercase text-muted-foreground">Заморозка</div>
              {status === "frozen" ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    {membership.frozen_until
                      ? `Заморожен до ${formatDate(membership.frozen_until)}`
                      : "Заморожен"}
                    {` · доступно ${remaining} из ${allowed} дн.`}
                  </p>
                  <Button variant="outline" onClick={handleUnfreeze} disabled={busy}>
                    {freezing && <Loader2 className="animate-spin" />}
                    Разморозить
                  </Button>
                </div>
              ) : status === "active" || status === undefined ? (
                <FormField
                  label="Дней заморозки"
                  tip="«Действует до» сдвинется на столько же дней."
                  hint={`Доступно ${remaining} из ${allowed} дн.`}
                >
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={remaining}
                      value={freezeDaysInput}
                      onChange={(e) => setFreezeDaysInput(e.target.value)}
                      // Enter здесь замораживает, а не сохраняет форму целиком.
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!busy && remaining > 0) void handleFreeze();
                        }
                      }}
                      placeholder={String(remaining)}
                      disabled={remaining <= 0}
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      onClick={handleFreeze}
                      disabled={busy || remaining <= 0}
                    >
                      {freezing && <Loader2 className="animate-spin" />}
                      Заморозить
                    </Button>
                  </div>
                </FormField>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Доступно {remaining} из {allowed} дн.
                </p>
              )}
            </div>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {saving && <Loader2 className="animate-spin" />}
          Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
