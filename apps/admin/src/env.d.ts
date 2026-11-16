/// <reference types="vite/client" />

// Build-time переменные (вшиваются Vite и в клиентский, и в серверный бандл).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** "true" — тестовый стенд «Аналитики» (DEPLOY.md, шаг 18): метка «Стенд» в названии и на экране. */
  readonly VITE_STAND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
