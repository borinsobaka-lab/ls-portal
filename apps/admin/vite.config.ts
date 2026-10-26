import path from "node:path";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig(({ command }) => ({
  server: { host: "::", port: 8080 },
  // Vite uses PostCSS in dev and Lightning CSS only at build; running Lightning
  // CSS in both keeps the dev preview identical to the built output.
  css: { transformer: "lightningcss" },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src") },
      // Набор иконок — Hugeicons, но имена в коде остались от lucide: у
      // Hugeicons своя номенклатура, а менять её пришлось бы и в вендоренных
      // components/ui/*. Шим отдаёт иконки Hugeicons под именами lucide.
      { find: /^lucide-react$/, replacement: path.resolve(__dirname, "src/lib/icons.tsx") },
    ],
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
    ignoreOutdatedRequests: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      // Стандартные правила: модули *.server.* и @tanstack/react-start/server
      // в клиентский бандл не попадают — сборка падает. Свои client.files
      // здесь не задаём: они ЗАМЕНЯЮТ стандартный **/*.server.*, а не дополняют.
      importProtection: { behavior: "error" },
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
    }),
    // Nitro packages the SSR app as a standalone node-server bundle
    // (.output/server/index.mjs) — то, что запускает Dockerfile.
    // compressPublicAssets: рядом с каждым файлом /assets кладутся .br и .gz,
    // сервер отдаёт их по Accept-Encoding. Brotli жмёт JS на ~15–20% лучше
    // gzip, которым прокси Coolify сжимает ответы на лету.
    ...(command === "build"
      ? [
          nitro({
            preset: "node-server",
            compressPublicAssets: { gzip: true, brotli: true },
          }),
        ]
      : []),
    viteReact(),
  ],
}));
