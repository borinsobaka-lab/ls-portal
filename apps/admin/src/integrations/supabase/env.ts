/**
 * Публичные параметры Supabase — единственное место, где они читаются.
 *
 * VITE_* вшиваются Vite на этапе сборки и в клиентский, и в серверный бандл
 * (в Coolify это Build Variables), поэтому process.env здесь не нужен.
 */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[supabase] Не заданы VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — " +
      "запросы к базе работать не будут.",
  );
}
