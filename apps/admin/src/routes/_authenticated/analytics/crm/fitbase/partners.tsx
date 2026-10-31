import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsFbPartnersPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableToolbar } from "@/components/table-toolbar";
import { supabase } from "@/integrations/supabase/client";
import { FB_KEY, fbPartnerAccessQuery, type FbPartnerAccess } from "@/lib/analytics/fitbase/data";
import { AN_TITLES } from "@/lib/analytics/labels";
import { unwrap } from "@/lib/query";

export const Route = createFileRoute("/_authenticated/analytics/crm/fitbase/partners")({
  head: () => ({ meta: [{ title: "Доступ партнёров FitBase — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsFbPartnersPageSkeleton,
  component: AnalyticsFbPartnersPage,
});

const TEXT = {
  intro:
    "Назначьте человеку конкретные студии FitBase — он увидит «Мой город · FitBase» только по их данным во всех блоках отчёта. Используются существующие учётные записи «Пользователей и ролей». Города 1С и маркетинговые доступы не меняются. Снимите все галочки, чтобы закрыть доступ к FitBase.",
  targets:
    "Точка 0 города на доске «Мой город · FitBase» — их цели FitBase. Показывается, только когда выбраны все студии города; для отдельной студии и частичного доступа — нет.",
};

type Person = FbPartnerAccess["people"][number];
const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * «Интеграция FitBase» → «Доступ партнёров» (администратору аналитики) — их
 * admin_render / save_grants (/admin/fitbase-partners): студии каждому
 * человеку, и точка 0 городов (их CITY_TARGETS — вводит администратор).
 */
function AnalyticsFbPartnersPage() {
  const { data, error } = useQuery(fbPartnerAccessQuery);
  return (
    <AdminShell title={AN_TITLES.fbPartners}>
      <div className="max-w-5xl space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/analytics/crm/fitbase">
              <ArrowLeft />
              Интеграция FitBase
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/analytics/fitbase/mycity">Мой город · FitBase</Link>
          </Button>
        </div>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? null : (
          <>
            <PeopleCard data={data} />
            <TargetsCard data={data} />
          </>
        )}
      </div>
    </AdminShell>
  );
}

function PeopleCard({ data }: { data: FbPartnerAccess }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Person | null>(null);
  const names = useMemo(() => new Map(data.connections.map((c) => [c.id, c])), [data]);
  const q = query.trim().toLocaleLowerCase("ru");
  const people = data.people
    .filter(
      (p) =>
        !q ||
        p.full_name.toLocaleLowerCase("ru").includes(q) ||
        (p.email ?? "").toLocaleLowerCase("ru").includes(q),
    )
    .sort((a, b) => Number(b.studios.length > 0) - Number(a.studios.length > 0));
  return (
    <section className="space-y-3">
      <InfoNote>{TEXT.intro}</InfoNote>
      <TableToolbar>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Имя или почта"
          aria-label="Поиск человека"
        />
      </TableToolbar>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Человек</TableHead>
              <TableHead>Студии FitBase</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((p) => (
              <TableRow key={p.user_id}>
                <TableCell className="min-w-48">
                  <div className="font-medium">{p.full_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[p.position, p.email].filter(Boolean).join(" · ")}
                  </div>
                </TableCell>
                <TableCell>
                  {p.admin ? (
                    <StatusChip tone="info">Все студии — администратор аналитики</StatusChip>
                  ) : p.studios.length ? (
                    <span className="text-sm">
                      {p.studios
                        .map((id) => names.get(id))
                        .filter(Boolean)
                        .map((c) => `${c!.city} · ${c!.name}`)
                        .join(", ")}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">Нет доступа</span>
                  )}
                  {!p.active && p.studios.length > 0 && (
                    <StatusChip tone="warning" className="ml-2">
                      Не действует
                    </StatusChip>
                  )}
                </TableCell>
                <TableCell>
                  <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                    Студии
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!people.length && (
              <TableRow>
                <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                  {q
                    ? "Никого не нашлось"
                    : "Сначала заведите людей в «Пользователях и ролях», затем назначьте студии здесь."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          {editing && (
            <StudiosForm
              key={editing.user_id}
              person={editing}
              data={data}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function StudiosForm({
  person,
  data,
  onClose,
}: {
  person: Person;
  data: FbPartnerAccess;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState(() => new Set(person.studios));
  const [saving, setSaving] = useState(false);
  const cities = useMemo(() => {
    const m = new Map<string, FbPartnerAccess["connections"]>();
    for (const c of data.connections) {
      if (!m.has(c.city)) m.set(c.city, []);
      m.get(c.city)!.push(c);
    }
    return [...m].sort(([a], [b]) => codeSort(a, b));
  }, [data]);
  const toggle = (id: number, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = async () => {
    setSaving(true);
    try {
      await unwrap(
        supabase.rpc("an_fb_partner_access_save", {
          p_user: person.user_id,
          p_ids: [...picked].sort((a, b) => a - b),
        }),
      );
      await qc.invalidateQueries({ queryKey: [...FB_KEY] });
      toast.success("Доступ сохранён.");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{person.full_name}</DialogTitle>
        <DialogDescription>
          Студии FitBase, которые человек видит в «Мой город · FitBase».
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void submit()}>
        <DialogBody className="space-y-4">
          {cities.map(([city, list]) => (
            <div key={city} className="space-y-1">
              <p className="text-sm font-semibold">{city}</p>
              {list.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={picked.has(c.id)}
                    onCheckedChange={(v) => toggle(c.id, v === true)}
                  />
                  <span>
                    {c.name} <span className="text-muted-foreground">· {c.brand}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
          {!cities.length && <InfoNote>Подключённых студий FitBase пока нет.</InfoNote>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить доступ
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

const rub = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

function TargetsCard({ data }: { data: FbPartnerAccess }) {
  const [editing, setEditing] = useState<string | null>(null);
  const targets = new Map(data.targets.map((t) => [t.city, t.amount_cents]));
  const cities = [...data.cities].sort(codeSort);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Точка 0 по городам</h2>
      <InfoNote>{TEXT.targets}</InfoNote>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Город</TableHead>
              <TableHead className="text-right">Точка 0</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {cities.map((city) => (
              <TableRow key={city}>
                <TableCell className="font-medium">{city}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {targets.has(city) ? `${rub.format(targets.get(city)! / 100)} ₽` : "Не задана"}
                </TableCell>
                <TableCell>
                  <Button variant="outline" size="sm" onClick={() => setEditing(city)}>
                    Изменить
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!cities.length && (
              <TableRow>
                <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                  Подключённых студий FitBase пока нет.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          {editing && (
            <TargetForm
              key={editing}
              city={editing}
              cents={targets.get(editing) ?? null}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TargetForm({
  city,
  cents,
  onClose,
}: {
  city: string;
  cents: number | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(cents === null ? "" : String(cents / 100));
  const [saving, setSaving] = useState(false);
  const save = async (amount: number | null) => {
    setSaving(true);
    try {
      await unwrap(
        supabase.rpc("an_fb_city_target_save", { p_city: city, p_amount_cents: amount }),
      );
      await qc.invalidateQueries({ queryKey: [...FB_KEY] });
      toast.success("Точка 0 сохранена.");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const submit = () => {
    const text = value.replace(/\s/g, "").replace(",", ".");
    const n = Number(text);
    if (!text || !Number.isFinite(n) || n < 0) {
      toast.error("Укажите сумму в рублях.");
      return;
    }
    void save(Math.round(n * 100));
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Точка 0 · {city}</DialogTitle>
        <DialogDescription>Цель выручки города за месяц, рубли.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={submit}>
        <DialogBody>
          <FormField label="Сумма, ₽" required>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              placeholder="Например, 1 500 000"
              autoFocus
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          {cents !== null && (
            <Button
              variant="outline"
              className="mr-auto"
              onClick={() => void save(null)}
              disabled={saving}
            >
              Убрать
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
