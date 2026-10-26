/// <reference types="vite/client" />

// Build-time переменные (вшиваются Vite и в клиентский, и в серверный бандл).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
