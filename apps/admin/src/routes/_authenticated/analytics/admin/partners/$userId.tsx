import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import {
  AnalyticsPartnerBodySkeleton,
  AnalyticsPartnerPageSkeleton,
} from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  anPartnerCardQuery,
  anPartnerRpc,
  invalidatePartners,
  type AnPartnerCard,
} from "@/lib/analytics/admin-data";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/admin/partners/$userId")({
  head: () => ({ meta: [{ title: "Карточка партнёра — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsPartnerPageSkeleton,
  component: AnalyticsPartnerPage,
});

// Кнопка «Сохранить карточку» — в плавающих действиях, связана с формой по id.
const FORM_ID = "an-partner-card";

type Draft = AnPartnerCard["profile"] & {
  cities: { city: string; trial_price: string; directions: string }[];
};

const toDraft = (card: AnPartnerCard): Draft => ({
  ...card.profile,
  cities: card.cities.map(({ city, trial_price, directions }) => ({
    city,
    trial_price,
    directions,
  })),
});

/**
 * Карточка партнёра — их partner_profile_page: реквизиты и контакты, его
 * города со студиями (справочник студий «Обработки 1С»), стоимость пробного
 * и направления города.
 */
function AnalyticsPartnerPage() {
  const { userId } = Route.useParams();
  const { data: card, error, isPending } = useQuery(anPartnerCardQuery(userId));
  const [saving, setSaving] = useState(false);

  return (
    <AdminShell
      title={card?.full_name ?? AN_TITLES.partner}
      actions={
        card && (
          <Button type="submit" form={FORM_ID} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Сохранить карточку
          </Button>
        )
      }
    >
      <div className="max-w-5xl space-y-4">
        <Link
          to="/analytics/admin/partners"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> К списку партнёров
        </Link>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : isPending || !card ? (
          <AnalyticsPartnerBodySkeleton />
        ) : (
          <PartnerCardForm key={card.user_id} card={card} onSavingChange={setSaving} />
        )}
      </div>
    </AdminShell>
  );
}

function PartnerCardForm({
  card,
  onSavingChange,
}: {
  card: AnPartnerCard;
  onSavingChange: (saving: boolean) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(card));
  const set = <K extends keyof AnPartnerCard["profile"]>(field: K, value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));
  const setCity = (city: string, field: "trial_price" | "directions", value: string) =>
    setDraft((d) => ({
      ...d,
      cities: d.cities.map((c) => (c.city === city ? { ...c, [field]: value } : c)),
    }));

  const save = async () => {
    const inn = draft.inn.trim();
    if (inn && !/^(\d{10}|\d{12})$/.test(inn)) {
      toast.error("ИНН должен состоять из 10 или 12 цифр.");
      return;
    }
    onSavingChange(true);
    try {
      await anPartnerRpc.saveCard(card.user_id, draft);
      await invalidatePartners(qc);
      toast.success("Карточка сохранена");
    } catch (e) {
      toast.error("Не удалось сохранить карточку", { description: (e as Error).message });
    } finally {
      onSavingChange(false);
    }
  };

  return (
    <form
      id={FORM_ID}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-4"
    >
      <section className="rounded-lg border bg-background p-4">
        <div className="text-sm text-muted-foreground">
          {[card.position || "Партнёр", card.email].filter(Boolean).join(" · ")}
        </div>
      </section>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <h2 className="text-lg font-semibold">Реквизиты и контакты</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="ИП">
            <Input
              value={draft.individual_entrepreneur}
              onChange={(e) => set("individual_entrepreneur", e.target.value)}
              placeholder="Например, ИП Иванова Анна Олеговна"
            />
          </FormField>
          <FormField label="ИНН" tip="10 или 12 цифр.">
            <Input
              inputMode="numeric"
              value={draft.inn}
              onChange={(e) => set("inn", e.target.value)}
              placeholder="10 или 12 цифр"
            />
          </FormField>
          <FormField label="Номер телефона">
            <Input
              value={draft.phone}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="+7 999 000-00-00"
            />
          </FormField>
          <FormField label="Telegram">
            <Input
              value={draft.telegram}
              onChange={(e) => set("telegram", e.target.value)}
              placeholder="@username или ссылка"
            />
          </FormField>
          <FormField label="MAX">
            <Input
              value={draft.max_messenger}
              onChange={(e) => set("max_messenger", e.target.value)}
              placeholder="Контакт в MAX"
            />
          </FormField>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <div>
          <h2 className="text-lg font-semibold">Города, студии и условия</h2>
          <p className="text-sm text-muted-foreground">Города меняются в разделе «Партнёры».</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {card.cities.map((c) => {
            const d = draft.cities.find((x) => x.city === c.city);
            return (
              <article key={c.city} className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <div>
                  <h3 className="font-semibold">{c.city}</h3>
                  <p className="text-sm text-muted-foreground">
                    Студий: <span className="font-medium text-foreground">{c.studios.length}</span>
                  </p>
                </div>
                <ul className="divide-y border-y text-sm">
                  {c.studios.length ? (
                    c.studios.map((s) => (
                      <li key={s.name} className="flex justify-between gap-3 py-2">
                        <span>{s.name}</span>
                        <span className="shrink-0 text-muted-foreground">{s.status}</span>
                      </li>
                    ))
                  ) : (
                    <li className="py-2 text-muted-foreground">
                      Справочник студий ещё не опубликован.
                    </li>
                  )}
                </ul>
                <FormField label="Стоимость пробного занятия">
                  <Input
                    inputMode="decimal"
                    value={d?.trial_price ?? ""}
                    onChange={(e) => setCity(c.city, "trial_price", e.target.value)}
                    placeholder="Например, 500 ₽"
                  />
                </FormField>
                <FormField label="Направления города">
                  <Textarea
                    rows={3}
                    value={d?.directions ?? ""}
                    onChange={(e) => setCity(c.city, "directions", e.target.value)}
                    placeholder="Например, Lady Stretch, Lady Dance"
                  />
                </FormField>
              </article>
            );
          })}
        </div>
      </section>
    </form>
  );
}
