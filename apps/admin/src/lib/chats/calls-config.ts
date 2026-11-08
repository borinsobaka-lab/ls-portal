/**
 * Включены ли видеозвонки (ключ Kinescope на сервере) — один запрос на
 * вкладку: без ключа кнопки «Видеозвонок» и окна звонков нет.
 */
import { useQuery } from "@tanstack/react-query";

import { getChatCallsConfig } from "./calls.functions";

export function useChatCallsEnabled(): boolean {
  const { data } = useQuery({
    queryKey: ["chat_calls_config"],
    queryFn: () => getChatCallsConfig(),
    staleTime: Infinity,
    retry: 1,
  });
  return data?.enabled ?? false;
}
