import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Loader2, Pencil, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { FbConnectionForm, FbStudioCard } from "@/components/analytics/fitbase/parts";
import { AnalyticsFitbaseConnectionPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { saveFitbaseRules, startFitbaseAction } from "@/lib/analytics/fitbase.functions";
import {
  fbConnectionQuery,
  fbRpc,
  invalidateFitbase,
  type FbConnectionView,
} from "@/lib/analytics/fitbase/data";
import {
  FB_ATTENDANCE_STATUSES,
  FB_OUTCOMES,
  FB_SOURCE_BUDGETS,
  fbAttendanceRules,
  fbAttendanceStateLabel,
} from "@/lib/analytics/fitbase/rules";
import { FB_TRIAL_SERVICES_TEXT } from "@/lib/analytics/fitbase/trials";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/crm/fitbase/$connectionId")({
  head: () => ({ meta: [{ title: "Настройки студии FitBase — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsFitbaseConnectionPageSkeleton,
  component: AnalyticsFitbaseConnectionPage,
});

const UNSET = "__unset";

/**
 * «Интеграция FitBase» → настройки студии (администратору аналитики) — их
 * fitbase_page(id): подключение, «Проверить подключение» (клубы, воронки,
 * этапы, источники), правила маркетинговой воронки и бюджетов источников,
 * статус студии и значения кодов записей с примерами для сверки.
 */
function AnalyticsFitbaseConnectionPage() {
  const { connectionId } = Route.useParams();
  const id = Number(connectionId);
  const { data, isPending, error } = useQuery(fbConnectionQuery(id));
  const [editing, setEditing] = useState(false);

  return (
    <AdminShell title={data?.name ?? AN_TITLES.fitbaseConnection}>
      <div className="max-w-5xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/analytics/crm/fitbase">
            <ArrowLeft />
            Все студии
          </Link>
        </Button>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : isPending || !data ? null : (
          <>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
              <FbStudioCard c={data} nightly={data.nightly} settingsLink={false} />
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil />
                Изменить подключение
              </Button>
            </div>
            <VerifySection c={data} />
            <RulesSection
              key={`${data.club_id}|${JSON.stringify(data.metadata.steps?.length)}`}
              c={data}
            />
            <AttendanceSection key={JSON.stringify(data.attendance_rules)} c={data} />
            {/* Их settings_link (fitbase_trial_services). */}
            <Card title="Какие услуги считать пробными" hint={FB_TRIAL_SERVICES_TEXT.link}>
              <Button asChild variant="outline">
                <Link to="/analytics/crm/fitbase/trial-services" search={{ id }}>
                  Настроить пробные услуги
                </Link>
              </Button>
            </Card>
          </>
        )}
      </div>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-2xl">
          {editing && data && <FbConnectionForm current={data} onClose={() => setEditing(false)} />}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Их «Проверка подключения». */
function VerifySection({ c }: { c: FbConnectionView }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    try {
      await startFitbaseAction({ data: { id: c.id, action: "verify" } });
      toast.success("Проверка запущена: клубы, воронки и источники загрузятся в фоне.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await invalidateFitbase(qc);
      setBusy(false);
    }
  };
  return (
    <Card
      title="Проверка подключения"
      hint="Загрузите доступные клубы, воронки и источники перед настройкой."
    >
      <Button variant="outline" disabled={c.busy || busy} onClick={() => void verify()}>
        {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        Проверить подключение
      </Button>
    </Card>
  );
}

/** Их «Правила маркетинговой воронки» и «Привязка источников к бюджету». */
function RulesSection({ c }: { c: FbConnectionView }) {
  const qc = useQueryClient();
  const steps = c.metadata.steps ?? [];
  const sources = c.metadata.sources ?? [];
  const clubs = c.metadata.clubs ?? [];
  const [club, setClub] = useState(c.club_id);
  const [stepRules, setStepRules] = useState<Record<string, string>>(() =>
    Object.fromEntries(steps.map((s) => [String(s.id), c.step_rules[String(s.id)] ?? "working"])),
  );
  const [sourceRules, setSourceRules] = useState<Record<string, string>>(() =>
    Object.fromEntries(sources.map((s) => [String(s.id), c.source_rules[String(s.id)] ?? "none"])),
  );
  const [saving, setSaving] = useState(false);
  if (!steps.length) {
    return (
      <Card title="Настройки этапов">
        <p className="text-sm">
          Нажмите «Проверить подключение» выше и дождитесь окончания. После загрузки здесь появятся
          реальные воронки и источники этой студии.
        </p>
      </Card>
    );
  }
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!club) {
      toast.error("Выберите клуб из FitBase.");
      return;
    }
    setSaving(true);
    try {
      await saveFitbaseRules({ data: { id: c.id, club, steps: stepRules, sources: sourceRules } });
      toast.success("Правила сохранены, загружаем лиды.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      await invalidateFitbase(qc);
      setSaving(false);
    }
  };
  return (
    <Card
      title="Правила маркетинговой воронки"
      hint="Укажите, что означает каждый этап. Для нового подключения предложены соответствия по вашим названиям; проверьте их перед выгрузкой."
    >
      <form className="space-y-4" onSubmit={(e) => void save(e)}>
        <FormField label="Клуб FitBase" required className="max-w-sm">
          <Select value={club || UNSET} onValueChange={(v) => setClub(v === UNSET ? "" : v)}>
            <SelectTrigger aria-label="Клуб FitBase">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>Выберите клуб</SelectItem>
              {clubs.map((k) => (
                <SelectItem key={String(k.id)} value={String(k.id)}>
                  {k.name || String(k.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Воронка</TableHead>
                <TableHead>Этап</TableHead>
                <TableHead>Что означает</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((s) => (
                <TableRow key={String(s.id)}>
                  <TableCell className="text-sm">{s.purchase_funnel?.name || "Воронка"}</TableCell>
                  <TableCell className="text-sm">{s.name ?? ""}</TableCell>
                  <TableCell>
                    <Select
                      value={stepRules[String(s.id)]}
                      onValueChange={(v) => setStepRules((r) => ({ ...r, [String(s.id)]: v }))}
                    >
                      <SelectTrigger
                        className="w-full md:w-60"
                        aria-label={`Этап ${s.name ?? s.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(FB_OUTCOMES).map(([k, v]) => (
                          <SelectItem key={k} value={k}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div>
          <h3 className="font-semibold">Привязка источников к бюджету</h3>
          <p className="text-sm text-muted-foreground">
            Расходы берём из реестра VK по направлению и городу. Источники одного бюджетного типа
            объединяются в одну строку, чтобы бюджет не удваивался.
          </p>
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Источник FitBase</TableHead>
                <TableHead>Бюджет портала</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => (
                <TableRow key={String(s.id)}>
                  <TableCell className="text-sm">{s.name || "Без названия"}</TableCell>
                  <TableCell>
                    <Select
                      value={sourceRules[String(s.id)]}
                      onValueChange={(v) => setSourceRules((r) => ({ ...r, [String(s.id)]: v }))}
                    >
                      <SelectTrigger
                        className="w-full md:w-52"
                        aria-label={`Источник ${s.name ?? s.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FB_SOURCE_BUDGETS.map(([k, v]) => (
                          <SelectItem key={k} value={k}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Button type="submit" disabled={saving || c.busy}>
          {saving && <Loader2 className="animate-spin" />}
          Сохранить правила
        </Button>
      </form>
    </Card>
  );
}

/** Их «Занятия и посещаемость»: статус студии и значения кодов записей. */
function AttendanceSection({ c }: { c: FbConnectionView }) {
  const qc = useQueryClient();
  const effective = fbAttendanceRules(c.attendance_rules);
  const [status, setStatus] = useState<string>(c.studio_status);
  const [rules, setRules] = useState<Record<string, string>>(() =>
    Object.fromEntries(c.status_details.map((d) => [d.status, effective[d.status] ?? ""])),
  );
  const [saving, setSaving] = useState(false);
  const numeric = c.status_details
    .filter((d) => /^\d+$/.test(d.status))
    .map((d) => Number(d.status));
  let note = `В загруженных записях найдено кодов: ${c.status_details.length}. Это встреченные значения, а не полный справочник статусов FitBase.`;
  if (numeric.length && Math.max(...numeric) - Math.min(...numeric) <= 30) {
    const missing: number[] = [];
    for (let n = Math.min(...numeric); n <= Math.max(...numeric); n++)
      if (!numeric.includes(n)) missing.push(n);
    if (missing.length) {
      note += ` В этой выгрузке не встретились коды: ${missing.join(", ")}. Их отсутствие не означает ошибку загрузки.`;
    }
  }
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await fbRpc.attendanceSettings(c.id, status, rules);
      await invalidateFitbase(qc);
      toast.success("Настройки сохранены.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="Занятия и посещаемость" hint={fbAttendanceStateLabel(c.attendance_state)}>
      <p className="text-sm text-muted-foreground">{note}</p>
      <details className="text-sm">
        <summary className="cursor-pointer select-none">Расшифровка статусов FitBase</summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>
            Значения кодов проверены в кабинете FitBase: 0 — Не подтверждено; 1 — Подтверждено; 2 —
            Отказался; 3 — Пришёл; 4 — Не пришёл; 5 — Поздняя отмена; 7 — В ожидании; 8 — Ожидает
            оплаты. Код 6 в фильтре FitBase означает «Все», это не статус отдельной записи.
          </p>
          <p>
            Эти значения применяются автоматически ко всем студиям и уже загруженным данным.
            Сохранённые вами соответствия имеют приоритет. Для сверки можно раскрыть примеры: дата,
            ID клиента, занятия и записи.{" "}
            <a
              href="https://help.fitbase.io/article/8850"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Справка FitBase: значения статусов
            </a>
          </p>
        </div>
      </details>
      <form className="space-y-4" onSubmit={(e) => void save(e)}>
        <FormField label="Статус студии" className="max-w-xs">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="Статус студии">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Действующая</SelectItem>
              <SelectItem value="archived">Архивная</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {c.status_details.length ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Код из API</TableHead>
                  <TableHead>Что означает в FitBase</TableHead>
                  <TableHead>Записи для сверки</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.status_details.map((d) => (
                  <TableRow key={d.status}>
                    <TableCell>
                      <div className="font-medium">Код {d.status}</div>
                      <div className="text-xs text-muted-foreground">Записей: {d.count}</div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={rules[d.status] || UNSET}
                        onValueChange={(v) =>
                          setRules((r) => ({ ...r, [d.status]: v === UNSET ? "" : v }))
                        }
                      >
                        <SelectTrigger
                          className="w-full md:w-64"
                          aria-label={`Значение кода ${d.status}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNSET}>Не определён — выберите статус</SelectItem>
                          {Object.entries(FB_ATTENDANCE_STATUSES).map(([k, v]) => (
                            <SelectItem key={k} value={k}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-sm">
                      <details>
                        <summary className="cursor-pointer select-none">Показать примеры</summary>
                        <ul className="mt-1 space-y-1">
                          {d.examples.map((x) => (
                            <li key={x.registration_id}>
                              <b>{x.day}</b> · {x.training_name}
                              <br />
                              Клиент: {x.client_key || "не указан"} · занятие № {x.event_id} ·
                              запись № {x.registration_id}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Примеры появятся после загрузки занятий этой студии.
          </p>
        )}
        <Button type="submit" disabled={saving || c.busy}>
          {saving && <Loader2 className="animate-spin" />}
          Сохранить настройки посещаемости
        </Button>
      </form>
    </Card>
  );
}
