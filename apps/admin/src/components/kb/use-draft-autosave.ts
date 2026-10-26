import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAutosave, type AutosaveResult } from "@/components/kb/use-autosave";
import { supabase } from "@/integrations/supabase/client";
import { KB_DRAFTS_KEY } from "@/lib/kb/data";

export type { AutosaveState } from "@/components/kb/use-autosave";

const DELAY_MS = 1200;

/**
 * Автосохранение черновика статьи на сервер (RPC kb_save_draft) — правки не
 * теряются и видны с другого устройства (боль брифа: в Платруме они жили в
 * браузере). Очередь, повторы и уход со страницы — `useAutosave`.
 * `expected` — метка черновика, с которой открыли редактор: разошлась
 * (сохранил кто-то ещё) — «conflict», дальше не пишем, чтобы не затереть
 * чужие правки.
 */
export function useDraftAutosave(nodeId: string, expected: string | null) {
  const qc = useQueryClient();
  const token = useRef<string | null>(expected);

  const save = useCallback(
    async (doc: unknown[]): Promise<AutosaveResult> => {
      const { data, error } = await supabase.rpc("kb_save_draft", {
        p_node: nodeId,
        p_content: doc,
        p_expected: token.current,
      });
      if (error) return error.message.includes("kb_draft_conflict") ? "conflict" : "error";
      token.current = data as string;
      void qc.invalidateQueries({ queryKey: [KB_DRAFTS_KEY] });
      return "ok";
    },
    [nodeId, qc],
  );

  return useAutosave(save, DELAY_MS);
}
