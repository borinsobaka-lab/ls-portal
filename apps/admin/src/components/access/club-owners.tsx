import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { AccessSection } from "@/components/access/parts";
import { Button } from "@/components/ui/button";
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
import { CheckboxOption, InfoNote } from "@/components/ui/form-field";
import { SearchInput } from "@/components/ui/search-input";
import {
  accessRpc,
  invalidateAccess,
  networkStudiosQuery,
  orgBrandsQuery,
  studioOwnersQuery,
} from "@/lib/access/data";

type PickItem = { id: string; label: string; sub?: string | null };

/**
 * Выбор нескольких из списка с поиском: собственники клуба (пользователи
 * портала) и клубы собственника. Выбранные — сверху.
 */
export function MultiPick({
  items,
  value,
  onChange,
  empty,
  searchPlaceholder,
}: {
  items: PickItem[];
  value: string[];
  onChange: (ids: string[]) => void;
  empty: string;
  searchPlaceholder: string;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const chosen = new Set(value);
  const shown = items
    .filter((i) => !term || `${i.label} ${i.sub ?? ""}`.toLowerCase().includes(term))
    .sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)));
  return (
    <div className="space-y-2">
      {items.length > 8 && (
        <SearchInput value={q} onChange={setQ} placeholder={searchPlaceholder} />
      )}
      <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
        {shown.length === 0 ? (
          <p className="p-1 text-sm text-muted-foreground">{empty}</p>
        ) : (
          shown.map((i) => (
            <CheckboxOption
              key={i.id}
              checked={chosen.has(i.id)}
              onCheckedChange={(on) =>
                onChange(on ? [...value, i.id] : value.filter((x) => x !== i.id))
              }
            >
              {i.label}
              {i.sub && <span className="text-muted-foreground"> · {i.sub}</span>}
            </CheckboxOption>
          ))
        )}
      </div>
    </div>
  );
}

/** Клубы сети для выбора: название, бренд и город. */
function useClubPickItems(): PickItem[] {
  const { data: studios } = useQuery(networkStudiosQuery);
  const { data: brands } = useQuery(orgBrandsQuery);
  return useMemo(() => {
    const brand = new Map((brands ?? []).map((b) => [b.id, b.short_name || b.name]));
    return (studios ?? []).map((s) => ({
      id: s.id,
      label: s.name,
      sub: [s.brand_id ? brand.get(s.brand_id) : null, s.city].filter(Boolean).join(", ") || null,
    }));
  }, [studios, brands]);
}

/**
 * Карточка пользователя: клубы, где он собственник (вторая сторона «Сети
 * клубов»). Меняет тот, у кого «Оргструктура и сеть».
 */
export function UserClubsSection({ userId, canEdit }: { userId: string; canEdit: boolean }) {
  const { data: owners } = useQuery(studioOwnersQuery);
  const items = useClubPickItems();
  const [open, setOpen] = useState(false);
  const mine = (owners ?? []).filter((o) => o.user_id === userId).map((o) => o.studio_id);
  const own = items.filter((i) => mine.includes(i.id));
  return (
    <AccessSection
      title="Собственник клубов"
      hint="Роли с областью «Клубы собственника» (например, «Владелец клуба — аналитика») действуют у него в этих клубах."
      action={
        canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Pencil /> Изменить
          </Button>
        ) : null
      }
    >
      {own.length === 0 ? (
        <InfoNote variant="empty">Не собственник клубов.</InfoNote>
      ) : (
        <ul className="divide-y">
          {own.map((c) => (
            <li key={c.id} className="py-2 text-sm">
              <span className="font-medium">{c.label}</span>
              {c.sub && <span className="text-muted-foreground"> · {c.sub}</span>}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          {open && (
            <UserClubsForm
              userId={userId}
              initial={mine}
              items={items}
              onClose={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </AccessSection>
  );
}

function UserClubsForm({
  userId,
  initial,
  items,
  onClose,
}: {
  userId: string;
  initial: string[];
  items: PickItem[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await accessRpc("org_user_studios_set", { p_user: userId, p_studios: value });
      await invalidateAccess(qc);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Клубы собственника</DialogTitle>
        <DialogDescription>Те же собственники видны у клуба в «Сети клубов».</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <MultiPick
            items={items}
            value={value}
            onChange={setValue}
            empty="Клубов нет — заведите их в «Оргструктуре» → «Сеть клубов»."
            searchPlaceholder="Найти клуб"
          />
        </DialogBody>
        <DialogFooter>
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
