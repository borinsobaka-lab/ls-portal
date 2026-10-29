import { createFileRoute } from "@tanstack/react-router";

import { hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import {
  applyReplicaBody,
  readReplicaBody,
  ReplicaError,
  replicaSecret,
  verifyReplicaRequest,
} from "@/lib/analytics/server/replica.server";

// Приём синхронизации со старого портала аналитики (агент на их сервере,
// deploy/analytics-replica). Вне авторизации портала: граница — подпись
// HMAC общим секретом ANALYTICS_REPLICA_SECRET (lib/analytics/server/replica.server.ts).
export const Route = createFileRoute("/api/analytics/replica")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = replicaSecret();
        if (!secret || !hasSupabaseAdmin()) {
          return Response.json(
            { ok: false, error: "Приём синхронизации не настроен" },
            { status: 503 },
          );
        }
        try {
          const { raw, json } = await readReplicaBody(request);
          const problem = verifyReplicaRequest(
            secret,
            request.headers.get("x-replica-time"),
            request.headers.get("x-replica-signature"),
            raw,
          );
          if (problem) return Response.json({ ok: false, error: problem }, { status: 401 });
          const results = await applyReplicaBody(json);
          return Response.json({ ok: results.every((r) => !r.error), results });
        } catch (e) {
          const status = e instanceof ReplicaError ? e.status : 500;
          if (status === 500) console.error("[analytics] приём синхронизации:", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status });
        }
      },
    },
  },
});
