import "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /**
       * Сохранение в браузере между запусками (src/lib/query-persist.ts):
       * false — не сохранять, "stable" — сохранять и через деплой.
       */
      persist?: false | "stable";
    };
  }
}
