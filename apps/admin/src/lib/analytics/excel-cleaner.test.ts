import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createInflateRaw, deflateRawSync } from "node:zlib";

import {
  cleanWorkbook,
  defaultOutputName,
  formatReport,
  type DeflateStream,
} from "./excel-cleaner";
import { XlsxDate, iterRows, openWorkbook, type Cell, type Inflate } from "./onec/xlsx-read";
import { zip } from "./onec/xlsx-write";

const inflate: Inflate = async function* (data) {
  for await (const chunk of Readable.from([data]).pipe(createInflateRaw())) {
    yield chunk as Uint8Array;
  }
};

const deflate: DeflateStream = async (source) => {
  const chunks: Uint8Array[] = [];
  for await (const c of source) chunks.push(c);
  return [new Uint8Array(deflateRawSync(Buffer.concat(chunks)))];
};

const enc = new TextEncoder();
const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Книга из готового XML листов (как выгрузка 1С: общие строки, стиль даты). */
async function book(sheets: { name: string; xml: string }[], strings: string[]) {
  const files = [
    {
      name: "xl/workbook.xml",
      text: `<workbook ${NS}><sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    },
    {
      name: "xl/styles.xml",
      text: `<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    },
    {
      name: "xl/sharedStrings.xml",
      text: `<sst ${NS}>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: s.xml })),
  ];
  return zip(files.map((f) => ({ name: f.name, data: enc.encode(f.text) })));
}

/** Листы очищенной книги: имя и строки по `widths` столбцов (у записи нет <dimension>). */
async function readBack(bytes: Uint8Array, widths: number[]) {
  const wb = await openWorkbook(bytes, inflate);
  const out: { name: string; rows: Cell[][] }[] = [];
  for (let i = 0; i < wb.sheets.length; i++) {
    const rows: Cell[][] = [];
    const sheet = await wb.open(i, { formulas: true });
    for await (const r of iterRows(sheet, { maxCol: widths[i] })) rows.push(r);
    out.push({ name: wb.sheets[i].name, rows });
  }
  return out;
}

/** XML листа очищенной книги — проверить стили и формулы. */
async function sheetText(bytes: Uint8Array, index: number) {
  const entries: string[] = [];
  // Локальные заголовки zip по порядку: имя, затем сжатые данные.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (view.getUint32(p, true) === 0x04034b50) {
    const size = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const data = bytes.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    if (name === `xl/worksheets/sheet${index + 1}.xml`) {
      let text = "";
      for await (const c of inflate(data)) text += new TextDecoder().decode(c, { stream: true });
      return text;
    }
    entries.push(name);
    p += 30 + nameLen + size;
  }
  throw new Error(`нет листа ${index + 1}: ${entries.join(", ")}`);
}

const SHEET_1 = `<worksheet ${NS}>
<dimension ref="A1:F8"/>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="2" max="2" width="3" hidden="1"/><col min="4" max="5" outlineLevel="1"/></cols>
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
<row r="2" outlineLevel="1"><c r="A2"><v>12.5</v></c><c r="C2" s="1"><v>45580</v></c><c r="D2" t="inlineStr"><is><t>Ваке</t></is></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>   </t></is></c></row>
<row r="4" hidden="1"><c r="A4"><f>A2*2</f><v>25</v></c><c r="D4" t="e"><v>#N/A</v></c><c r="E4" t="b"><v>1</v></c></row>
<row r="6"><c r="A6"><v>0.1</v></c><c r="C6" s="1"><v>0.75</v></c><c r="D6" t="str"><v>=не формула</v></c></row>
<row r="12"><c r="A12"><v>99</v></c></row>
</sheetData>
<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="D1:E1"/></mergeCells>
</worksheet>`;

const SHEET_2 = `<worksheet ${NS}><sheetData><row r="2"><c r="B2" t="s"><v>3</v></c></row></sheetData></worksheet>`;

describe("Очистка Excel (их ExcelCleaner 1.1-fast)", () => {
  test("отчёт по листам и плоский лист без пустых строк и столбцов", async () => {
    const input = await book(
      [
        { name: "Продажи", xml: SHEET_1 },
        { name: "Пусто", xml: SHEET_2 },
      ],
      ["Клиент", "Дата", "Клуб", "Итог"],
    );
    const steps: string[] = [];
    const { report, output } = await cleanWorkbook(
      "Выгрузка.xlsx",
      input,
      { inflate, deflate },
      (_d, _t, m) => {
        if (steps[steps.length - 1] !== m) steps.push(m);
      },
    );

    expect(report).toEqual([
      {
        name: "Продажи",
        mergedRangesRemoved: 2,
        // Строки 2 и 4, столбцы B (скрыт) и D:E (группировка — max-min+1).
        outlineItemsCleared: 5,
        // Столбцы до F по <dimension>: B (только пробелы) и F пустые.
        emptyColumnsRemoved: 2,
        // Строки до 8 по <dimension>: 3, 5, 7, 8; строка 12 за границей не читается.
        emptyRowsRemoved: 4,
      },
      {
        name: "Пусто",
        mergedRangesRemoved: 0,
        outlineItemsCleared: 0,
        emptyColumnsRemoved: 1,
        emptyRowsRemoved: 1,
      },
    ]);
    expect(steps[0]).toBe("Быстрый режим: анализирую структуру файла");
    expect(steps).toContain("Файл открыт в потоковом режиме");
    expect(steps).toContain("Продажи: ищу пустые строки и столбцы");
    expect(steps).toContain("Продажи: записываю очищенный лист");
    expect(steps).toContain("Сохраняю новый быстрый .xlsx");
    expect(steps[steps.length - 1]).toBe("Готово");

    const sheets = await readBack(output, [4, 1]);
    expect(sheets.map((s) => s.name)).toEqual(["Продажи", "Пусто"]);
    expect(sheets[0].rows).toEqual([
      ["Клиент", "Дата", "Клуб", null],
      [12.5, new XlsxDate("2024-10-15 00:00:00"), "Ваке", null],
      ["=A2*2", null, "#N/A", true],
      [0.1, new XlsxDate("1899-12-31 18:00:00"), "=не формула", null],
    ]);
    expect(sheets[1].rows).toEqual([["Итог"]]);

    const xml = await sheetText(output, 0);
    expect(xml).toContain('<sheetFormatPr baseColWidth="8" defaultRowHeight="20"/>');
    expect(xml).toContain('<col min="4" max="4" width="20" customWidth="1"/>');
    expect(xml).not.toContain('<col min="5"');
    expect(xml).not.toContain("mergeCell");
    expect(xml).not.toContain("outlineLevel");
    // Шапка — перенос и по верху (стиль 1), пустая ячейка шапки — со стилем.
    expect(xml).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(xml).toContain('<c r="D1" s="1"/>');
    // Дата — числом с форматом «yyyy-mm-dd h:mm:ss», время — «h:mm:ss».
    expect(xml).toContain('<c r="B2" s="2" t="n"><v>45580</v></c>');
    expect(xml).toContain('<c r="B4" s="4" t="n"><v>0.75</v></c>');
    // Строка с «=» в начале — формула, код ошибки — ошибка (как у openpyxl).
    expect(xml).toContain('<c r="A3"><f>A2*2</f><v></v></c>');
    expect(xml).toContain('<c r="C3" t="e"><v>#N/A</v></c>');
    expect(xml).toContain('<c r="C4"><f>не формула</f><v></v></c>');
  });

  test("недопустимый символ и не .xlsx — ошибка", async () => {
    const bad = await book(
      [
        {
          name: "Лист1",
          xml: `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&#1;b</t></is></c></row></sheetData></worksheet>`,
        },
      ],
      [],
    );
    await expect(cleanWorkbook("x.xlsx", bad, { inflate, deflate })).rejects.toThrow(
      "недопустимый символ",
    );
    await expect(cleanWorkbook("x.xls", bad, { inflate, deflate })).rejects.toThrow(
      "Сейчас поддерживаются только файлы .xlsx",
    );
  });

  test("имя результата и текст отчёта — как у них", () => {
    expect(defaultOutputName("Продажи 10.2026.xlsx")).toBe("Продажи 10.2026_очищено.xlsx");
    expect(
      formatReport([
        {
          name: "Лист1",
          mergedRangesRemoved: 3,
          emptyColumnsRemoved: 2,
          emptyRowsRemoved: 10,
          outlineItemsCleared: 1,
        },
      ]),
    ).toBe(
      [
        "Готово. Отчет по листам:",
        "- Лист1:",
        "объединений убрано - 3",
        "группировок строк/столбцов сброшено - 1",
        "пустых столбцов удалено - 2",
        "пустых строк удалено - 10",
      ].join("\n"),
    );
  });
});
