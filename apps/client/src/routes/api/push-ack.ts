import { createFileRoute } from "@tanstack/react-router";

import { untypedDb } from "@/lib/untyped-db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Подтверждение от телефона (service worker, public/sw.js): пуш показан
 * (delivered) или на него нажали (clicked) — счётчики «Доставлено» и
 * «Прочитано» в админке. Отдельный адрес на своём домене: у service worker
 * нет ни сессии, ни адреса базы. Пропуск — id доставки из самого пуша
 * (случайный uuid), RPC push_delivery_ack с публичным ключом; повтор ничего
 * не меняет (db/migrations/2026-10-15_push_delivery.sql).
 */
export const Route = createFileRoute("/api/push-ack")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        type Ack = { d?: unknown; e?: unknown };
        const body = (await request.json().catch(() => null)) as Ack | null;
        const id = typeof body?.d === "string" && UUID_RE.test(body.d) ? body.d : null;
        const event = body?.e === "delivered" || body?.e === "clicked" ? body.e : null;
        if (!id || !event) return new Response(null, { status: 400 });
        const { error } = await untypedDb.rpc("push_delivery_ack", { p_id: id, p_event: event });
        if (error) console.error("[push-ack]", error.message);
        return new Response(null, {
          status: error ? 502 : 204,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
