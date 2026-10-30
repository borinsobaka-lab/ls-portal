import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as hg from "@hugeicons/core-free-icons";

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${d}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${d}/${e.name}`] : [],
  );

// Редактор базы знаний (@blocknote/shadcn) тоже импортирует lucide-react —
// alias подменяет и его импорты, поэтому его иконки нужны в шиме.
const VENDOR = ["node_modules/@blocknote/shadcn/dist/blocknote-shadcn.js"];

const used = new Set<string>();
for (const f of [...walk("src"), ...VENDOR]) {
  if (f.endsWith("src/lib/icons.tsx")) continue;
  for (const m of readFileSync(f, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g))
    for (const raw of m[1].split(","))
      if (raw.trim())
        used.add(
          raw
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        );
}

// Hugeicons отдаёт псевдонимы под именами lucide, но не для всех и не всегда
// удачные — эти подобраны глазами по сетке всех кандидатов.
const MANUAL: Record<string, string> = {
  AlertTriangle: "Alert02Icon", // псевдоним AlertTriangle — кружок, а не треугольник
  Ban: "BanIcon", // псевдонима под именем lucide нет; знак «отменено» в расписании
  BarChart3: "BarChart",
  Cat: "CatIcon",
  // Вид графика на дашборде: псевдонимы ChartColumn/ChartArea — не те фигуры,
  // берём одно семейство «оси + фигура».
  ChartArea: "ChartAreaIcon",
  ChartColumn: "ChartColumnIcon",
  ChartLine: "ChartLineIcon",
  CheckCircle2: "CheckCircle",
  ChevronsUpDown: "UnfoldMoreIcon", // псевдоним — стрелки ↑↓, нужен «раскрыть»
  FileSpreadsheet: "FileSpreadsheetIcon", // выгрузки 1С в «Аналитике»; псевдонима нет
  FolderInput: "FolderTransferIcon", // «Переместить…» в базе знаний; псевдонима нет
  GripVertical: "DragDropVerticalIcon", // псевдоним — рука, нужны точки-ручка
  HelpCircle: "HelpCircleIcon", // псевдонима под именем lucide нет
  Loader2: "LoaderCircle",
  // Полный экран расписания: псевдонимы Maximize/Minimize — не те фигуры,
  // нужны стрелки наружу и внутрь.
  Maximize: "ArrowExpandIcon",
  Minimize: "ArrowShrinkIcon",
  Pencil: "PencilEdit02Icon", // псевдоним — карандаш остриём вниз, читался как вилка
  RefreshCwOff: "RefreshCwOffIcon", // псевдоним не перечёркнут, не отличить от RefreshCw
  Send: "SentIcon", // псевдоним — конверт, для кнопки отправки нужен самолётик
  UserArrowLeftRight: "UserArrowLeftRightIcon", // «Переоформить» абонемент; в lucide такой нет
  Vk: "VkIcon", // «VK Видео» в меню «/» базы знаний; в lucide такой нет
};

const rows = [...used].sort().map((name) => {
  const source = MANUAL[name] ?? name;
  if (!(source in hg)) throw new Error(`нет иконки для ${name} (искали ${source})`);
  return { name, source, manual: !!MANUAL[name] };
});

const imports = rows.map((r) => `  ${r.source} as ${r.name}Art,`).join("\n");
const exports = rows
  .map((r) => `export const ${r.name} = icon(${r.name}Art, "${r.name}");`)
  .join("\n");

writeFileSync(
  "src/lib/icons.tsx",
  `/**
 * Иконки Hugeicons под именами lucide-react.
 *
 * Alias в vite.config превращает каждый \`from "lucide-react"\` в этот файл,
 * поэтому имена в компонентах менять не пришлось — включая вендоренные
 * components/ui/*, которые лучше держать близко к upstream shadcn.
 *
 * Hugeicons именует иконки по-своему (Search01Icon, Delete02Icon), но заодно
 * отдаёт псевдонимы под именами lucide — по ним и импортируем. Часть
 * псевдонимов оказались неточными (AlertTriangle рисовался кружком,
 * RefreshCwOff не отличался от RefreshCw, Send был конвертом) — для них
 * иконка выбрана вручную, см. MANUAL в scripts/gen-icons.ts.
 *
 * Импортируем поимённо, а не через \`import * as\`: иначе в бандл уезжает весь
 * пакет — на Solar так и вышло, лишние 482 kB.
 *
 * Файл сгенерирован scripts/gen-icons.ts; добавляя иконку, дописывай импорт и export парой.
 */
import { forwardRef, type SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
${imports}
} from "@hugeicons/core-free-icons";

type LucideProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  color?: string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
};

/** Обёртка, принимающая пропсы в стиле lucide (size / color / strokeWidth). */
function icon(art: IconSvgElement, displayName: string) {
  const Comp = forwardRef<SVGSVGElement, LucideProps>(function Comp(props, ref) {
    return <HugeiconsIcon ref={ref} icon={art} {...props} />;
  });
  Comp.displayName = displayName;
  return Comp;
}

${exports}
`,
);
console.log(
  `иконок: ${rows.length}, из них подобрано вручную: ${rows.filter((r) => r.manual).length}`,
);
