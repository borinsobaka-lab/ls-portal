import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsFbTrialServicesPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  loadFitbaseTrialCatalog,
  saveFitbaseTrialServices,
} from "@/lib/analytics/fitbase.functions";
import {
  FB_KEY,
  fbTrialServicesQuery,
  type FbTrialServicesView,
} from "@/lib/analytics/fitbase/data";
import { FB_TRIAL_SERVICES_TEXT } from "@/lib/analytics/fitbase/trials";
import { AN_TITLES } from "@/lib/analytics/labels";

type ServicesSearch = { id?: number };

export const Route = createFileRoute("/_authenticated/analytics/crm/fitbase/trial-services")({
  head: () => ({ meta: [{ title: "Настройка пробных услуг — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): ServicesSearch => {
    const id = Number(s.id);
    return { id: Number.isInteger(id) && id > 0 ? id : undefined };
  },
  pendingComponent: AnalyticsFbTrialServicesPageSkeleton,
  component: AnalyticsFbTrialServicesPage,
});

/** Их ответ на неверный филиал (fitbase_trial_services.route). */
const BAD = "Проверьте параметры филиала и повторите запрос.";

/**
 * «Интеграция FitBase» → студия → «Пробные услуги» (администратору
 * аналитики) — их fitbase_trial_services: какие услуги филиала считать
 * пробными, каталог услуг из FitBase, режим «Автоматически» / «По выбранным
 * услугам». После сохранения типы записей студии пересчитываются.
 */
function AnalyticsFbTrialServicesPage() {
  const { id } = Route.useSearch();
  const { data, error, isPending } = useQuery({
    ...fbTrialServicesQuery(id ?? 0),
    enabled: Boolean(id),
  });
  const bad = !id || (!isPending && !error && (!data || !data.club_id));

  return (
    <AdminShell title={AN_TITLES.fbTrialServices}>
      <div className="max-w-4xl space-y-4">
        {bad ? (
          <InfoNote variant="warning">{BAD}</InfoNote>
        ) : error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? null : (
          <ServicesForm key={data.owner} view={data} />
        )}
      </div>
    </AdminShell>
  );
}

function ServicesForm({ view }: { view: FbTrialServicesView }) {
  const qc = useQueryClient();
  const rule = view.rule;
  const [mode, setMode] = useState<"auto" | "selected">(rule?.mode ?? "auto");
  const [chosen, setChosen] = useState<Set<string>>(new Set(rule?.selected ?? []));
  const [busy, setBusy] = useState<"catalog" | "save" | null>(null);
  const [message, setMessage] = useState<{ error?: string; saved?: boolean }>({});
  const reload = () => qc.invalidateQueries({ queryKey: [...FB_KEY, "trial-services", view.id] });

  const loadCatalog = async () => {
    setBusy("catalog");
    setMessage({});
    try {
      await loadFitbaseTrialCatalog({ data: { id: view.id } });
      await reload();
    } catch (e) {
      setMessage({ error: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    setMessage({});
    try {
      await saveFitbaseTrialServices({
        data: {
          id: view.id,
          owner: view.owner,
          mode,
          selected: [...chosen],
          revision: String(rule?.revision ?? 0),
        },
      });
      await qc.invalidateQueries({ queryKey: FB_KEY });
      setMessage({ saved: true });
    } catch (e) {
      setMessage({ error: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link
            to="/analytics/crm/fitbase/$connectionId"
            params={{ connectionId: String(view.id) }}
          >
            <ArrowLeft />
            Настройки филиала
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/analytics/fitbase/trials" search={{ studio: String(view.id) }}>
            Открыть воронку
          </Link>
        </Button>
      </div>
      <h2 className="text-lg font-semibold">Пробные услуги · {view.name}</h2>
      {message.error && <InfoNote variant="warning">{message.error}</InfoNote>}
      {message.saved && <InfoNote>{FB_TRIAL_SERVICES_TEXT.saved}</InfoNote>}
      {rule?.mode === "auto" && rule.selected.length > 0 && (
        <InfoNote variant="warning">{FB_TRIAL_SERVICES_TEXT.autoWarning}</InfoNote>
      )}
      <section className="space-y-4 rounded-lg border bg-background p-4">
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{FB_TRIAL_SERVICES_TEXT.selected}</p>
          <p>{FB_TRIAL_SERVICES_TEXT.scope}</p>
        </div>
        <Button variant="outline" onClick={() => void loadCatalog()} disabled={busy !== null}>
          {busy === "catalog" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Обновить список услуг из FitBase
        </Button>
        <FormField label="Режим">
          <Select value={mode} onValueChange={(v) => setMode(v as "auto" | "selected")}>
            <SelectTrigger className="w-full sm:w-96">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Автоматически — флаг и название FitBase</SelectItem>
              <SelectItem value="selected">По выбранным услугам</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <div className="space-y-2">
          <h3 className="font-semibold">Услуги филиала</h3>
          {view.catalog.length ? (
            <div className="grid gap-1 sm:grid-cols-2">
              {view.catalog.map((r) => (
                <label
                  key={r.service_id}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={chosen.has(r.service_id)}
                    onCheckedChange={(v) => {
                      // Их скрипт: изменение галочки переключает режим на «По выбранным».
                      setMode("selected");
                      setChosen((s) => {
                        const n = new Set(s);
                        if (v === true) n.add(r.service_id);
                        else n.delete(r.service_id);
                        return n;
                      });
                    }}
                  />
                  <span className="text-sm">
                    {r.name}{" "}
                    <small className="text-muted-foreground">
                      ID {r.service_id}
                      {r.archived ? " · архив" : ""}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{FB_TRIAL_SERVICES_TEXT.empty}</p>
          )}
        </div>
        <Button onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" && <Loader2 className="animate-spin" />}
          Сохранить пробные услуги
        </Button>
      </section>
    </>
  );
}
