import { createFileRoute, Link, Navigate } from "@tanstack/react-router";

import { AdminShell } from "@/components/admin-shell";
import { readLastKbBase, useMyKbBases } from "@/lib/kb/my-bases";
import { KbNodePageSkeleton } from "@/components/page-skeletons";
import { useAdminAccess } from "@/hooks/use-admin-access";

export const Route = createFileRoute("/_authenticated/kb/")({
  head: () => ({ meta: [{ title: "База знаний — Lady Stretch" }] }),
  pendingComponent: KbNodePageSkeleton,
  component: KbEntry,
});

/**
 * «База знаний» в рейке: сразу в последнюю открытую базу (её запоминают
 * вкладки в шапке), иначе — в первую из открытых сотруднику. Баз нет —
 * подсказка, где их заводят.
 */
function KbEntry() {
  const access = useAdminAccess();
  const { bases, loading } = useMyKbBases();
  if (loading) return <KbNodePageSkeleton />;
  const last = readLastKbBase();
  const target = bases.find((b) => b.id === last) ?? bases[0];
  if (target) return <Navigate to="/kb/$baseId" params={{ baseId: target.id }} replace />;
  return (
    <AdminShell title="База знаний">
      <div className="mx-auto max-w-3xl py-8 text-center text-sm text-muted-foreground">
        {access?.kbAdmin ? (
          <>
            Баз знаний пока нет. Заведите первую в{" "}
            <Link to="/kb-bases" className="font-medium text-foreground underline">
              «Управление» → «Знания»
            </Link>
            .
          </>
        ) : (
          "Вам пока не открыта ни одна база знаний."
        )}
      </div>
    </AdminShell>
  );
}
