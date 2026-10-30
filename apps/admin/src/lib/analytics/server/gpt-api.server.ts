/**
 * API для Custom GPT на сервере портала — их обработка /api/v1/* (app.py):
 * ключ из «Authorization: Bearer» по SHA-256 (an_api_key_check), каждый
 * ответ — в журнал запросов (an_api_log), ошибки — их JSON. Данные доски —
 * их full_reports.py (onec-reports/payload.ts) по текущему снимку 1С: отчёты
 * сервер читает сервис-ключом по всей сети (an_onec_scope).
 */
import { createHash } from "node:crypto";

import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";

import { gptCatalog, gptDate, gptOpenApi, GPT_DASHBOARDS } from "../gpt-api";
import {
  onecPayload,
  parseAggregate,
  type OnecBoard,
  type OnecGrain,
  type OnecReportMeta,
} from "../onec-reports/payload";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    response: new Response(text, { status, headers: JSON_HEADERS }),
    bytes: Buffer.byteLength(text),
  };
}

/** Адрес портала для схемы: ADMIN_APP_URL, иначе — адрес запроса. */
function serverUrl(request: Request) {
  return process.env.ADMIN_APP_URL?.trim() || new URL(request.url).origin;
}

/** Их /openapi.json — без ключа. */
export function gptOpenApiResponse(request: Request) {
  return json(gptOpenApi(serverUrl(request))).response;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabaseAdmin().rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Данные доски — как у досок портала, по всей сети. */
async function boardPayload(board: OnecBoard, start?: string, end?: string) {
  const meta = await rpc<OnecReportMeta | null>("an_onec_report_meta", { p_board: board });
  if (!meta) throw new Error("Загрузите пакет обработчика");
  return onecPayload(
    board,
    { start, end, studio: "", city: "" },
    meta,
    async (report, s, e, grain: OnecGrain = "detail") =>
      parseAggregate(
        grain,
        await rpc("an_onec_aggregate", {
          p_board: board,
          p_report: report,
          p_start: s,
          p_end: e,
          p_grain: grain,
          p_studio: "",
          p_city: "",
        }),
      ),
  );
}

/** Их /api/v1/*: `rest` — путь после «/v1/». */
export async function gptApiResponse(request: Request, rest: string): Promise<Response> {
  const url = new URL(request.url);
  let keyId: number | null = null;
  const finish = async ({ response, bytes }: { response: Response; bytes: number }) => {
    try {
      await rpc("an_api_log", {
        p_key: keyId,
        p_method: request.method,
        p_path: url.pathname,
        p_query: url.search.slice(1, 2001),
        p_status: response.status,
        p_bytes: bytes,
      });
    } catch (e) {
      console.error("[analytics api] журнал запросов:", (e as Error).message);
    }
    return response;
  };

  if (!hasSupabaseAdmin()) return json({ error: "dashboard_data_unavailable" }, 503).response;
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const hash = createHash("sha256").update(header.slice(7).trim()).digest("hex");
    keyId = await rpc<number | null>("an_api_key_check", { p_hash: hash });
  }
  if (!keyId) return finish(json({ error: "unauthorized" }, 401));

  if (rest === "catalog") return finish(json(gptCatalog()));
  if (rest.startsWith("dashboards/")) {
    // Их name = path.rsplit("/", 1)[-1].
    const board = GPT_DASHBOARDS[rest.split("/").pop() ?? ""];
    if (!board) return finish(json({ error: "dashboard_not_found" }, 404));
    try {
      const payload = await boardPayload(
        board,
        gptDate(url.searchParams.get("start")),
        gptDate(url.searchParams.get("end")),
      );
      return finish(json(payload));
    } catch (e) {
      return finish(
        json({ error: "dashboard_data_unavailable", details: (e as Error).message }, 503),
      );
    }
  }
  return finish(json({ error: "not_found" }, 404));
}
