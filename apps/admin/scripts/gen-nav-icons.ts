/**
 * Иконки бокового меню — Solar, вынутые из @solar-icons/react: Outline для
 * обычного пункта, BoldDuotone для активного.
 *
 * Пакет кладёт в каждую иконку все шесть начертаний: двадцать иконок меню
 * прибавляли к бандлу ~226 kB (51 kB gzip), из которых нужно два. Скрипт
 * рендерит нужные начертания в статичную разметку и пишет готовые
 * компоненты в src/components/nav-icons.tsx; сам пакет — только devDependency.
 *
 * Запуск: bun run scripts/gen-nav-icons.ts. Добавляя пункт меню — допиши
 * иконку в ICONS (имя как на solar-icons.vercel.app, путь — категория в пакете).
 */
import { writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ICONS: Record<string, string> = {
  Alarm: "time",
  Bag3: "shopping",
  Bell: "notifications",
  BellBing: "notifications",
  BillList: "money",
  Bolt: "ui",
  Broom: "ui",
  Buildings2: "building",
  Book: "school",
  Book2: "school",
  BookBookmark: "school",
  CalendarAdd: "time",
  CalendarMinimalistic: "time",
  Card: "money",
  Case: "school",
  City: "building",
  Chart2: "business",
  ChartSquare: "business",
  ChatRoundDots: "messages",
  ChatRoundLine: "messages",
  ClipboardCheck: "notes",
  ClipboardList: "notes",
  ClipboardRemove: "notes",
  Crown: "ui",
  CupStar: "ui",
  Diploma: "school",
  DocumentText: "notes",
  Documents: "notes",
  Dumbbell: "sports",
  DumbbellSmall: "sports",
  Fire: "nature",
  Flag: "ui",
  Folder: "folders",
  FolderOpen: "folders",
  Gift: "ui",
  GraphNewUp: "business",
  GraphUp: "business",
  HandHeart: "hands",
  HandShake: "hands",
  HashtagCircle: "it",
  Heart: "like",
  History: "time",
  HomeSmile: "ui",
  Letter: "messages",
  LinkRound: "text-formatting",
  Lightbulb: "devices",
  MapPoint: "map",
  MoneyBag: "money",
  Notebook: "notes",
  PhoneCallingRounded: "call",
  PieChart2: "business",
  Ranking: "sports",
  Refresh: "arrows",
  QuestionCircle: "ui",
  Rocket: "astronomy",
  Settings: "settings",
  ShieldCheck: "security",
  ShieldUser: "security",
  Smartphone: "devices",
  SquareAcademicCap: "school",
  Star: "like",
  StarShine: "like",
  Structure: "it",
  StarsMinimalistic: "astronomy",
  TagPrice: "money",
  Target: "ui",
  TicketSale: "money",
  UploadMinimalistic: "arrows-action",
  UserSpeakRounded: "users",
  UserId: "users",
  UsersGroupRounded: "users",
  WalletMoney: "money",
  Widget3: "settings",
  Widget5: "settings",
};

// HTML-атрибуты → JSX-пропсы (stroke-width → strokeWidth), пустые теги — самозакрывающиеся.
const toJsx = (markup: string) =>
  markup
    .replace(
      / ([a-z]+)-([a-z]+)=/g,
      (_, a: string, b: string) => ` ${a}${b[0].toUpperCase()}${b.slice(1)}=`,
    )
    .replace(/<(path|circle|rect|ellipse|line)([^>]*)><\/\1>/g, "<$1$2 />");

// Координаты в d="…" у Solar — до 5 знаков после запятой; в сетке 24×24
// сотые доли — это сотые доли пикселя, глазом не отличить, а файл (и чанк
// меню, который грузит каждая страница) худеет на треть.
const roundPaths = (markup: string) =>
  markup.replace(/ d="([^"]*)"/g, (_, d: string) => {
    const short = d.replace(/-?\d*\.\d+/g, (n) => {
      const r = Number(Number(n).toFixed(2)).toString();
      return r === "-0" ? "0" : r.replace(/^(-?)0\./, "$1.");
    });
    return ` d="${short}"`;
  });

const WEIGHTS = { outline: "Outline", active: "BoldDuotone" } as const;

const render = (Icon: Parameters<typeof createElement>[0], weight: string) => {
  const svg = renderToStaticMarkup(createElement(Icon, { weight }));
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<>\n      ${toJsx(roundPaths(inner)).replace(/></g, ">\n      <")}\n    </>`;
};

const blocks: string[] = [];
for (const [name, category] of Object.entries(ICONS)) {
  const mod = await import(`@solar-icons/react/ssr/${category}/${name}`);
  const variants = Object.entries(WEIGHTS)
    .map(([key, weight]) => `    ${key}: ${render(mod.default, weight)},`)
    .join("\n");
  blocks.push(`export const ${name} = navIcon("${name}", {\n${variants}\n});`);
}

writeFileSync(
  "src/components/nav-icons.tsx",
  `/**
 * Иконки бокового меню: Solar, Outline у обычного пункта и BoldDuotone
 * у активного (проп \`active\`).
 * Файл сгенерирован scripts/gen-nav-icons.ts — руками не править.
 */
import { forwardRef, type ReactNode, type SVGProps } from "react";

export type NavIcon = ReturnType<typeof navIcon>;

type NavIconProps = SVGProps<SVGSVGElement> & { active?: boolean };

function navIcon(displayName: string, paths: { outline: ReactNode; active: ReactNode }) {
  const Comp = forwardRef<SVGSVGElement, NavIconProps>(function Comp({ active, ...props }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" {...props}>
        {active ? paths.active : paths.outline}
      </svg>
    );
  });
  Comp.displayName = displayName;
  return Comp;
}

${blocks.join("\n\n")}
`,
);
