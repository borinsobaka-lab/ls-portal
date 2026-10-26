import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { PageIntro, RoleChip } from "@/components/access/parts";
import { AccessRolesPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { accessCatalogQuery, accessRolesQuery } from "@/lib/access/data";
import { roleSummary } from "@/lib/access/logic";

export const Route = createFileRoute("/_authenticated/access/roles/")({
  head: () => ({ meta: [{ title: "Роли — Lady Stretch" }] }),
  pendingComponent: AccessRolesPageSkeleton,
  component: AccessRolesPage,
});

const TIPS = {
  users:
    "Скольким людям роль действует сейчас — выданная лично, через подразделение или должность.",
};

/**
 * «Роли» (ACCESS.md): наборы прав из каталога. Стартовые — из ТЗ портала
 * XFIT и схемы ролей Битрикс24 Lady Stretch; меняются и удаляются (кроме
 * суперадминистратора), новые — «Новая роль» или копией.
 */
function AccessRolesPage() {
  const navigate = useNavigate();
  const access = useAdminAccess();
  const { data: roles, isLoading, error } = useQuery(accessRolesQuery);
  const { data: catalog } = useQuery(accessCatalogQuery);
  const canEdit = hasRight(access, "roles.manage");
  return (
    <AdminShell
      title="Роли"
      actions={
        canEdit ? (
          <Button
            onClick={() =>
              void navigate({ to: "/access/roles/$roleId", params: { roleId: "new" } })
            }
          >
            <Plus /> Новая роль
          </Button>
        ) : null
      }
    >
      <div className="space-y-3">
        <PageIntro id="roles">
          Роль — набор прав; права человека складываются из всех его ролей. Роль выдаётся человеку,
          подразделению (можно вместе с нижними) или должности. Действует во всей сети, в клубах
          бренда, в выбранных клубах или в клубах, где человек собственник. Роль, полученную через
          подразделение или должность, снимают там (убрать из подразделения, сменить должность) или
          на странице роли — тогда она пропадёт у всех.
        </PageIntro>
        {error && !roles ? (
          <InfoNote variant="warning">{error.message}</InfoNote>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Роль</TableHead>
                  <TableHead>Права</TableHead>
                  <TableHead tip={TIPS.users} className="text-right">
                    Люди
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableSkeletonRows columns={3} rows={8} />
                ) : (
                  (roles ?? []).map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() =>
                        void navigate({ to: "/access/roles/$roleId", params: { roleId: r.id } })
                      }
                    >
                      <TableCell className="max-w-80 align-top">
                        <Link
                          to="/access/roles/$roleId"
                          params={{ roleId: r.id }}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1.5"
                        >
                          <RoleChip name={r.name} color={r.color} />
                          {r.locked && <Lock className="size-3.5 text-muted-foreground" />}
                        </Link>
                        {r.description && (
                          <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-wrap gap-1">
                          {roleSummary(r.permissions, catalog ?? []).map((t) => (
                            <span
                              key={t}
                              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {t}
                            </span>
                          ))}
                          {r.permissions.length === 0 && (
                            <span className="text-xs text-muted-foreground">Без прав</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">{r.users}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
