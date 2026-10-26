import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { RoleChip } from "@/components/access/parts";
import { ScopePicker, type Scope } from "@/components/access/scope-picker";
import { StaffAvatar } from "@/components/employee-photo";
import { ImageUploadField } from "@/components/image-upload-field";
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
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { createPortalUser, updatePortalUserAccount } from "@/lib/access.functions";
import {
  accessCatalogQuery,
  accessRolesQuery,
  accessRpc,
  invalidateAccess,
  orgPositionsQuery,
} from "@/lib/access/data";
import { hasStudioPerms, splitFullName, USER_TYPE_LABEL, USER_TYPES } from "@/lib/access/logic";
import type { PortalUserCard, UserType } from "@/lib/access/types";
import { squareImage } from "@/lib/storage";

const NONE = "none";

const TIPS = {
  email: "Логин: при каждом входе на эту почту приходит 6-значный код, пароля нет.",
  type: "Для фильтров и отчётов: сотрудник УК, партнёр-франчайзи, сотрудник клуба, подрядчик. На права не влияет.",
  position:
    "Справочник должностей — в «Оргструктуре». Роль, выданная должности, действует на всех, у кого она стоит.",
  until:
    "Последний день доступа (включительно) — демо-доступ партнёру или временный сотрудник. Потом вход закрывается сам, роли остаются.",
  roles: "Можно сразу выдать роли. Остальное — в карточке: роли, подразделения, личные права.",
  note: "Видно только тем, кто управляет пользователями.",
};

type ProfileFields = {
  last_name: string;
  first_name: string;
  phone: string;
  user_type: UserType | null;
  position_id: string | null;
  access_until: string;
  note: string;
};

function ProfileInputs({
  value,
  onChange,
  disabled,
  canClassify,
}: {
  value: ProfileFields;
  onChange: (v: ProfileFields) => void;
  disabled?: boolean;
  /** Тип, должность и срок меняет тот, кто управляет человеком (не сам он). */
  canClassify: boolean;
}) {
  const { data: positions } = useQuery(orgPositionsQuery);
  const set = (patch: Partial<ProfileFields>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Фамилия" required>
          <Input
            autoComplete="off"
            value={value.last_name}
            disabled={disabled}
            onChange={(e) => set({ last_name: e.target.value })}
          />
        </FormField>
        <FormField label="Имя" required>
          <Input
            autoComplete="off"
            value={value.first_name}
            disabled={disabled}
            onChange={(e) => set({ first_name: e.target.value })}
          />
        </FormField>
      </div>
      <FormField label="Телефон" optional>
        <Input
          type="tel"
          autoComplete="off"
          value={value.phone}
          disabled={disabled}
          onChange={(e) => set({ phone: e.target.value })}
        />
      </FormField>
      {canClassify && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Тип" tip={TIPS.type} optional>
              <Select
                value={value.user_type ?? NONE}
                onValueChange={(v) => set({ user_type: v === NONE ? null : (v as UserType) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Не указан</SelectItem>
                  {USER_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {USER_TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Должность" tip={TIPS.position} optional>
              <Select
                value={value.position_id ?? NONE}
                onValueChange={(v) => set({ position_id: v === NONE ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Не указана</SelectItem>
                  {(positions ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField label="Доступ до" tip={TIPS.until} optional>
            <Input
              type="date"
              value={value.access_until}
              onChange={(e) => set({ access_until: e.target.value })}
            />
          </FormField>
          <FormField label="Заметка" tip={TIPS.note} optional>
            <Textarea
              rows={2}
              maxLength={2000}
              value={value.note}
              onChange={(e) => set({ note: e.target.value })}
            />
          </FormField>
        </>
      )}
    </>
  );
}

function checkProfile(v: ProfileFields, email: string): string | null {
  if (!v.last_name.trim()) return "Укажите фамилию";
  if (!v.first_name.trim()) return "Укажите имя";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Укажите корректный email";
  return null;
}

type DraftRole = { key: number; role_id: string; scope: Scope };

/** Добавить человека: данные, почта для входа и (сразу) роли. */
export function NewUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" anchor="top">
        {open && <NewUserForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function NewUserForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useServerFn(createPortalUser);
  const access = useAdminAccess();
  const { data: roles } = useQuery(accessRolesQuery);
  const { data: catalog } = useQuery(accessCatalogQuery);
  const restricted = !access?.manageAll && !hasRight(access, "portal.admin");
  const [email, setEmail] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileFields>({
    last_name: "",
    first_name: "",
    phone: "",
    user_type: null,
    position_id: null,
    access_until: "",
    note: "",
  });
  const [drafts, setDrafts] = useState<DraftRole[]>([]);
  const [saving, setSaving] = useState(false);

  const addDraft = () =>
    setDrafts((d) => [
      ...d,
      {
        key: Date.now(),
        role_id: "",
        scope: restricted
          ? { scope_type: "studios", scope_ids: access?.manageStudioIds.slice(0, 1) ?? [] }
          : { scope_type: "all", scope_ids: [] },
      },
    ]);

  const save = async () => {
    const problem = checkProfile(profile, email);
    if (problem) {
      toast.error(problem);
      return;
    }
    for (const d of drafts) {
      const role = roles?.find((r) => r.id === d.role_id);
      if (!role) {
        toast.error("Выберите роль или уберите пустую строку");
        return;
      }
      if (
        hasStudioPerms(role.permissions, catalog ?? []) &&
        d.scope.scope_type !== "all" &&
        d.scope.scope_ids.length === 0
      ) {
        toast.error(`Роль «${role.name}»: отметьте клубы или бренды`);
        return;
      }
    }
    setSaving(true);
    try {
      const res = await create({
        data: {
          first_name: profile.first_name.trim(),
          last_name: profile.last_name.trim(),
          email: email.trim(),
          phone: profile.phone.trim() || undefined,
          user_type: profile.user_type,
          position_id: profile.position_id,
          access_until: profile.access_until || null,
          note: profile.note.trim() || undefined,
          avatar_url: avatar,
          assignments: drafts.map((d) => {
            const role = roles?.find((r) => r.id === d.role_id);
            const scope =
              role && hasStudioPerms(role.permissions, catalog ?? [])
                ? d.scope
                : { scope_type: "all" as const, scope_ids: [] };
            return { role_id: d.role_id, ...scope };
          }),
        },
      });
      toast.success(
        res.existing
          ? "Добавлен в портал. У человека уже была учётная запись — вход по коду на ту же почту"
          : "Добавлен. Вход — по коду, который придёт на указанную почту",
      );
      await invalidateAccess(qc);
      onDone();
      void navigate({ to: "/access/users/$userId", params: { userId: res.user_id } });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Не удалось сохранить";
      const existing = /^already_in_portal:(.+)$/.exec(message);
      if (existing) {
        toast.info("Этот человек уже есть в портале — открываем его карточку");
        onDone();
        void navigate({ to: "/access/users/$userId", params: { userId: existing[1] } });
      } else {
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Новый пользователь</DialogTitle>
        <DialogDescription>
          Вход в портал — по 6-значному коду на почту, пароля нет. Если у человека уже есть учётная
          запись (например, он клиент приложения), она просто получит доступ.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Аватарка" htmlFor={null} optional>
              <ImageUploadField
                bucket="avatars"
                folder="staff"
                value={avatar}
                onChange={setAvatar}
                prepare={(file) => squareImage(file)}
                preview={
                  <StaffAvatar
                    value={avatar}
                    name={`${profile.last_name} ${profile.first_name}`}
                    className="size-16 text-base"
                  />
                }
                disabled={saving}
              />
            </FormField>
            <ProfileInputs value={profile} onChange={setProfile} disabled={saving} canClassify />
            <FormField label="Email" tip={TIPS.email} required>
              <Input
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
            <FormField label="Роли" tip={TIPS.roles} htmlFor={null} optional>
              <div className="space-y-2">
                {drafts.map((d) => {
                  const role = roles?.find((r) => r.id === d.role_id);
                  const studioPerms = role
                    ? hasStudioPerms(role.permissions, catalog ?? [])
                    : false;
                  const update = (patch: Partial<DraftRole>) =>
                    setDrafts((all) => all.map((x) => (x.key === d.key ? { ...x, ...patch } : x)));
                  return (
                    <div key={d.key} className="space-y-2 rounded-md border p-3">
                      <div className="flex items-center gap-2">
                        <Select value={d.role_id} onValueChange={(role_id) => update({ role_id })}>
                          <SelectTrigger aria-label="Роль">
                            <SelectValue placeholder="Выберите роль" />
                          </SelectTrigger>
                          <SelectContent>
                            {(roles ?? []).map((r) => (
                              <SelectItem key={r.id} value={r.id} disabled={!!r.grant_problem}>
                                <RoleChip name={r.name} color={r.color} className="border-0 px-0" />
                                {r.grant_problem && (
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    {r.grant_problem}
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Убрать роль"
                          onClick={() => setDrafts((all) => all.filter((x) => x.key !== d.key))}
                        >
                          <X />
                        </Button>
                      </div>
                      {role && studioPerms && (
                        <ScopePicker
                          value={d.scope}
                          onChange={(scope) => update({ scope })}
                          allowedStudioIds={restricted ? (access?.manageStudioIds ?? []) : null}
                        />
                      )}
                    </div>
                  );
                })}
                <Button variant="outline" size="sm" onClick={addDraft}>
                  <Plus /> Роль
                </Button>
                {drafts.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Без ролей человек не войдёт в портал — выдать можно и потом, в карточке.
                  </p>
                )}
              </div>
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Добавить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/** Изменить данные человека: имя, телефон, почта, аватарка, тип, должность, срок. */
export function EditUserDialog({
  open,
  onOpenChange,
  user,
  isSelf,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: PortalUserCard;
  isSelf: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" anchor="top">
        {open && <EditUserForm user={user} isSelf={isSelf} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function EditUserForm({
  user,
  isSelf,
  onDone,
}: {
  user: PortalUserCard;
  isSelf: boolean;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const access = useAdminAccess();
  const updateAccount = useServerFn(updatePortalUserAccount);
  const canClassify = !isSelf || hasRight(access, "portal.admin");
  const [email, setEmail] = useState(user.email ?? "");
  const [avatar, setAvatar] = useState<string | null>(user.avatar_url);
  const [profile, setProfile] = useState<ProfileFields>({
    ...splitFullName(user.full_name),
    phone: user.phone ?? "",
    user_type: user.user_type,
    position_id: user.position_id,
    access_until: user.access_until ?? "",
    note: user.note ?? "",
  });
  const [saving, setSaving] = useState(false);
  const emailChanged = !!user.email && email.trim().toLowerCase() !== user.email.toLowerCase();

  const save = async () => {
    const problem = checkProfile(profile, email);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      await accessRpc("access_user_save", {
        p_user: user.user_id,
        p: {
          first_name: profile.first_name.trim(),
          last_name: profile.last_name.trim(),
          phone: profile.phone.trim(),
          ...(canClassify
            ? {
                user_type: profile.user_type ?? "",
                position_id: profile.position_id ?? "",
                access_until: profile.access_until,
                note: profile.note,
              }
            : {}),
        },
      });
      if (emailChanged || avatar !== user.avatar_url) {
        await updateAccount({
          data: { user_id: user.user_id, email: email.trim(), avatar_url: avatar },
        });
      }
      toast.success("Сохранено");
      await invalidateAccess(qc);
      void qc.invalidateQueries({ queryKey: ["staff-profile"] });
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Данные пользователя</DialogTitle>
        <DialogDescription>{user.full_name ?? user.email}</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Аватарка" htmlFor={null} optional>
              <ImageUploadField
                bucket="avatars"
                folder="staff"
                value={avatar}
                onChange={setAvatar}
                prepare={(file) => squareImage(file)}
                preview={
                  <StaffAvatar
                    value={avatar}
                    name={`${profile.last_name} ${profile.first_name}`}
                    className="size-16 text-base"
                  />
                }
                disabled={saving}
              />
            </FormField>
            <ProfileInputs
              value={profile}
              onChange={setProfile}
              disabled={saving}
              canClassify={canClassify}
            />
            <FormField label="Email" tip={TIPS.email} required>
              <Input
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
            {emailChanged && (
              <InfoNote>
                Почта — это логин: коды входа будут приходить на новую почту, на старую войти больше
                нельзя. Если человек — ещё и клиент приложения, там он тоже входит по новой почте.
              </InfoNote>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
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
