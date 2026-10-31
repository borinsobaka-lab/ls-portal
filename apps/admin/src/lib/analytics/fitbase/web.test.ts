import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { fbBasisClassifier, fbTrialOwner } from "./trials";
import {
  FbWebError,
  fbBasisJobOrder,
  fbBranchForm,
  fbCleanLabel,
  fbEvidenceDecide,
  fbLessonDay,
  fbListUrl,
  fbPaginationAction,
  fbParseHtml,
  fbParsePage,
  fbText,
  fbUnescape,
  fbWebOrigin,
  type FbBasisJob,
  type FbEvidenceLookup,
} from "./web";

// Их test_automatic.py: страница списка записей и строка записи.
const HEADERS = [
  "#",
  "Дата записи",
  "Клиент",
  "Телефон",
  "Основание",
  "Тип тренировки",
  "Дата занятия",
  "Статус",
];
const page = (rows = "", total = 1, headers = HEADERS) =>
  '<div id="w5"><table><thead><tr>' +
  headers.map((h) => `<th>${h}</th>`).join("") +
  "</tr></thead><tbody>" +
  rows +
  `</tbody></table><div class="summary">Показаны записи 1-10 из ${total}.</div><ul class="pagination"><li><a href="?page=2">2</a></li></ul></div>`;
const row = (rid: string, basis: string, status = "Отказался", when = "20.10.2026 16:00") =>
  `<tr data-key="${rid}"><td>1</td><td>19.10.2026</td><td>PRIVATE_CLIENT</td><td>PRIVATE_PHONE</td><td>${basis}</td><td>Групповая</td><td>${when}</td><td>${status}</td></tr>`;
const BASE = "https://ladyjump.fitbase.io/client-schedule/index";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FbWebError) return e.message;
    throw e;
  }
  return null;
};

describe("FitBase — страницы записей (их web_source)", () => {
  test("выбранное основание из списка, без данных клиента", () => {
    const html = page(
      row(
        "369363",
        '<select name="reason"><option value="service_999">Обычная услуга</option><option selected value="service_123">Пробное занятие (Не оплачен)|description-default|осталось 1 занятие</option><option value="service_456">НЕВЫБРАННОЕ</option></select>',
      ),
    );
    const { rows, total, lastPage } = fbParsePage(html, BASE);
    expect(rows[0].label).toBe("Пробное занятие");
    expect(rows[0].reason_ref).toBe("service_123");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    expect(JSON.stringify(rows)).not.toContain("НЕВЫБРАННОЕ");
    expect([total, lastPage]).toEqual([1, 2]);
  });

  test("основание одной услугой — без «(Не оплачен)» при любом статусе", () => {
    for (const status of ["Отказался", "Пришел", "Не пришел", "Поздняя отмена", "В ожидании"]) {
      const html = page(
        row(
          "369363",
          '<span class="item-name-single">Пробное занятие <span>(Не оплачен)</span></span>',
          status,
        ),
      );
      expect(fbParsePage(html, BASE).rows[0]).toEqual({
        registration_id: "369363",
        label: "Пробное занятие",
        reason_ref: "",
        lesson_time: "20.10.2026 16:00",
      });
    }
  });

  test("вход и смена разметки — ошибка, а не пустой список", () => {
    expect(code(() => fbParsePage('<form id="login-form"></form>', BASE))).toBe(
      "registration_grid_missing",
    );
    expect(code(() => fbParsePage(page("", 1, ["Unknown"]), BASE))).toBe(
      "registration_columns_changed",
    );
    expect(code(() => fbParsePage("<p>error</p>", BASE))).toBe("registration_grid_missing");
    expect(code(() => fbParsePage(page(row("bad", "x")), BASE))).toBe("invalid_registration_id");
    expect(code(() => fbParsePage(page("", 3), BASE))).toBe("nonempty_grid_without_rows");
    expect(
      code(() =>
        fbParsePage(page(row("1", "x")).replace(/<div class="summary">.*?<\/div>/, ""), BASE),
      ),
    ).toBe("registration_total_missing");
  });

  test("пустой список «Ничего не найдено» — не ошибка", () => {
    const html = page(
      '<tr><td colspan="8"><div class="empty">Ничего не найдено.</div></td></tr>',
      0,
    );
    const { rows, total } = fbParsePage(html, BASE);
    expect([rows, total]).toEqual([[], 0]);
    const noSummary = html.replace(/<div class="summary">.*?<\/div>/, "");
    expect(fbParsePage(noSummary, BASE).total).toBe(0);
  });

  test("одна запись с разными основаниями — ошибка; чужие ссылки страниц не считаются", () => {
    expect(
      code(() =>
        fbParsePage(
          page(
            row("1", '<span class="item-name-single">A</span>') +
              row("1", '<span class="item-name-single">B</span>'),
          ),
          BASE,
        ),
      ),
    ).toBe("conflicting_registration_rows");
    const html = page(row("1", "-")).replace("?page=2", "https://evil.example/steal?page=999");
    expect(fbParsePage(html, BASE).lastPage).toBe(1);
    const same = page(row("1", "-")).replace("?page=2", "/client-schedule/index?page=&page=7");
    expect(fbParsePage(same, BASE).lastPage).toBe(7);
  });

  test("заголовки строкой td, счётчик с неразрывными пробелами, ссылка основания", () => {
    const html =
      '<div id="w5"><table><tr>' +
      HEADERS.map((h) => `<td> ${h} </td>`).join("") +
      "</tr>" +
      row(
        "5",
        '<select name="reason"><option selected value="contract_77">Абонемент &laquo;8&raquo; | осталось</option></select>',
      ) +
      row(
        "6",
        '<select name="reason"><option selected value="javascript:1">Свой</option></select>',
      ) +
      '</table><div class="summary">Показаны записи 1-2 из 1&nbsp;204.</div></div>';
    const { rows, total } = fbParsePage(html, BASE);
    expect(total).toBe(1204);
    expect(rows.map((r) => [r.label, r.reason_ref])).toEqual([
      ["Абонемент «8»", "contract_77"],
      ["Свой", ""],
    ]);
  });

  test("слишком длинное основание", () => {
    const html = page(row("1", `<span class="item-name-single">${"я".repeat(501)}</span>`));
    expect(code(() => fbParsePage(html, BASE))).toBe("label_too_long");
    const ok = page(row("1", `<span class="item-name-single">${"я".repeat(500)}</span>`));
    expect(fbParsePage(ok, BASE).rows[0].label.length).toBe(500);
  });

  test("clean_label: до «|», без «(не оплачен…)», пробелы", () => {
    expect(fbCleanLabel("  Пробное\n занятие ( НЕ  оплачена ) | x")).toBe("Пробное занятие");
    expect(fbCleanLabel("Разовое (не оплачено)(не оплачены)")).toBe("Разовое");
    expect(fbCleanLabel("A B")).toBe("A B");
  });

  test("дерево HTML: ссылки на символы, void-теги, непарные закрытия, script", () => {
    expect(fbUnescape("&amp;&lt;&#1071;&#x44f;&nbsp;&copy &bogus;")).toBe("&<Яя © &bogus;");
    const doc = fbParseHtml(
      '<div a=1 b="2" c><br><img src="x"/><p>one<b>two</p>three</div><script>if (a<b) x="</div>&amp;"</script>',
    );
    const div = doc.children[0];
    expect(typeof div !== "string" && div.a).toEqual({ a: "1", b: "2", c: null });
    expect(fbText(doc)).toBe('onetwothreeif (a<b) x="</div>&amp;"');
  });

  test("форма выбора клуба: выбранный, доступные, защитный код", () => {
    const html = (selected: string) =>
      `<form action="/site/change-club"><input name="_csrf" value="PRIVATE_CSRF"><select name="club-picker"><option value="1" ${selected === "1" ? "selected" : ""}>One</option><option value="2" ${selected === "2" ? "selected" : ""}>Two</option></select></form>`;
    const f = fbBranchForm(html("2"));
    expect(f.fields).toEqual({ _csrf: "PRIVATE_CSRF" });
    expect([...f.allowed]).toEqual(["1", "2"]);
    expect(f.selected).toBe("2");
    expect(fbBranchForm(html("")).selected).toBe("");
    expect(code(() => fbBranchForm("<form action='/other'></form>"))).toBe("branch_form_missing");
  });

  test("адрес списка: фильтры их формы, свежие записи, обратный порядок", () => {
    const q = new URL(
      fbListUrl(
        "https://ladyjump.fitbase.io",
        "2026-10-01",
        "2026-10-31",
        2,
        "2026-10-19",
        "2026-10-21",
      ),
    ).searchParams;
    expect(q.get("ScheduleRegistrationsSearch[registration_status]")).toBe("");
    expect(q.get("ScheduleRegistrationsSearch[registration_date_from]")).toBe("19.10.2026");
    expect(q.get("ScheduleRegistrationsSearch[registration_date_range]")).toBe(
      "19.10.2026 - 21.10.2026",
    );
    expect(q.get("ScheduleRegistrationsSearch[schedule_time_start_range]")).toBe(
      "01.10.2026 - 31.10.2026",
    );
    expect([q.get("page"), q.get("per-page"), q.get("sort")]).toEqual([
      "2",
      "10",
      "registration_created_at",
    ]);
    const all = new URL(
      fbListUrl("https://x.fitbase.io", "2026-09-01", "2026-09-30", 1, null, null, true),
    ).searchParams;
    expect(all.get("ScheduleRegistrationsSearch[registration_date_to]")).toBe("31.12.2099");
    expect(all.get("sort")).toBe("-registration_created_at");
  });

  test("адрес FitBase по домену подключения", () => {
    expect(fbWebOrigin(" LadyJump ")).toBe("https://ladyjump.fitbase.io");
    expect(fbWebOrigin("https://ladyjump.fitbase.io/x")).toBe("https://ladyjump.fitbase.io");
    expect(code(() => fbWebOrigin("evil.example"))).toBe("Неверный домен FitBase.");
  });

  test("дата занятия со страницы", () => {
    expect(fbLessonDay("20.10.2026 16:00")).toBe("2026-10-20");
    expect(fbLessonDay("1.2.2026 9:5")).toBe("2026-02-01");
    expect(fbLessonDay("31.02.2026 10:00")).toBeNull();
    expect(fbLessonDay("20.10.2026")).toBeNull();
    expect(fbLessonDay("")).toBeNull();
  });
});

describe("FitBase — пагинация и очередь (их worker)", () => {
  test("частичное перекрытие страниц — допустимо, обратный проход закрывает пропуск", () => {
    const job = { page: 2, passes: 1, last_fingerprint: "", last_page: 0 };
    expect(fbPaginationAction(job, ["2", "3"], 3, 4, 2, sha256)[0]).toBe("reverse");
    expect(fbPaginationAction({ ...job, page: 1, passes: 2 }, ["4", "3"], 4, 4, 2, sha256)[0]).toBe(
      "advance",
    );
    expect(fbPaginationAction({ ...job, page: 2, passes: 2 }, ["2", "1"], 4, 4, 2, sha256)[0]).toBe(
      "complete",
    );
  });

  test("неустранимый пропуск не становится «готово»; повтор страницы — обратный проход", () => {
    expect(() =>
      fbPaginationAction(
        { page: 2, passes: 3, last_fingerprint: "", last_page: 0 },
        ["2", "3"],
        3,
        4,
        2,
        sha256,
      ),
    ).toThrow("pagination_gap");
    const [, fp] = fbPaginationAction(
      { page: 1, passes: 1, last_fingerprint: "", last_page: 0 },
      ["1", "2"],
      2,
      4,
      2,
      sha256,
    );
    expect(fp).toBe(sha256('["1","2"]'));
    expect(
      fbPaginationAction(
        { page: 2, passes: 1, last_page: 1, last_fingerprint: fp },
        ["1", "2"],
        2,
        4,
        2,
        sha256,
      )[0],
    ).toBe("reverse");
    expect(() =>
      fbPaginationAction(
        { page: 2, passes: 3, last_page: 1, last_fingerprint: fp },
        ["1", "2"],
        2,
        4,
        2,
        sha256,
      ),
    ).toThrow("pagination_repeated");
  });

  test("порядок: свежие, текущий месяц всех студий, затем прошлые", () => {
    const job = (connection_id: number, month: string, extra: Partial<FbBasisJob> = {}) =>
      ({
        connection_id,
        month,
        owner: "",
        lo: month === "recent" ? "2026-08-22" : `${month}-01`,
        hi: month === "recent" ? "2026-12-20" : `${month}-28`,
        page: 1,
        seen: 0,
        total: null,
        finished_at: 0,
        failed_at: 0,
        error: "",
        interval_seconds: 86400,
        anchor: "",
        direction: 0,
        passes: 1,
        last_fingerprint: "",
        last_page: 0,
        last_attempt: 0,
        ...extra,
      }) as FbBasisJob;
    const now = 2_000_000_000;
    const order = fbBasisJobOrder(
      [
        job(1, "2026-09"),
        job(2, "2026-10"),
        job(1, "2026-10"),
        job(2, "recent"),
        job(1, "2026-03"),
        job(2, "2026-09"),
        job(1, "2026-08", { failed_at: now - 100 }),
        job(2, "2026-07", { finished_at: now - 100 }),
      ],
      "2026-10-21",
      now,
    ).map((j) => `${j.connection_id}:${j.month}`);
    expect(order).toEqual([
      "2:recent",
      "1:2026-10",
      "2:2026-10",
      "1:2026-09",
      "2:2026-09",
      "1:2026-03",
    ]);
  });
});

describe("FitBase — приём основания (их apply_evidence)", () => {
  const c = { id: 1, domain: "ladyjump", club_id: "1" };
  const owner = fbTrialOwner(c);
  const resolve = fbBasisClassifier(
    { mode: "selected", selected: ["4"], revision: 1 },
    [
      { service_id: "4", name: "Пробное занятие" },
      { service_id: "8", name: "Обычная услуга" },
    ],
    [],
  );
  const look = (basis: Record<string, number> = {}): FbEvidenceLookup => ({
    owner,
    records: { "369363": ["52162", "2026-10-20"], "100": ["52162", "2026-10-20"] },
    basis,
  });
  const ev = (extra: Record<string, unknown> = {}) => ({
    registration_id: "369363",
    label: "Пробное занятие",
    reason_ref: "",
    lesson_time: "20.10.2026 16:00",
    captured_at: 100,
    ...extra,
  });

  test("пробное основание принимается с занятием записи", () => {
    const r = fbEvidenceDecide(owner, look(), [ev()], resolve, 500);
    expect(r.counts.trial).toBe(1);
    expect(r.accepted).toEqual([
      {
        owner,
        registration_id: "369363",
        event_id: "52162",
        label: "Пробное занятие",
        captured_at: 100,
        imported_at: 500,
      },
    ]);
    expect(
      fbEvidenceDecide(owner, look(), [ev({ label: "обычная  услуга" })], resolve, 1).counts
        .regular,
    ).toBe(1);
  });

  test("нужны та же студия, та же запись и тот же день занятия", () => {
    expect(
      fbEvidenceDecide(owner, look(), [ev({ lesson_time: "21.10.2026 16:00" })], resolve, 1).counts
        .time_mismatch,
    ).toBe(1);
    expect(
      fbEvidenceDecide(owner, look(), [ev({ registration_id: "999999" })], resolve, 1).counts
        .not_in_api_cache,
    ).toBe(1);
    expect(
      code(() =>
        fbEvidenceDecide(fbTrialOwner({ ...c, club_id: "2" }), look(), [ev()], resolve, 1),
      ),
    ).toBe("connection_owner_changed");
  });

  test("пустое не стирает прежнее, старое не перезаписывает новое", () => {
    const r = fbEvidenceDecide(
      owner,
      look({ "369363": 200 }),
      [ev({ label: "" }), ev({ captured_at: 100 })],
      resolve,
      1,
    );
    expect(r.counts).toMatchObject({ empty: 1, trial: 0 });
    expect(r.accepted).toEqual([]);
    expect(
      fbEvidenceDecide(owner, look({ "369363": 200 }), [ev({ captured_at: 200 })], resolve, 1)
        .accepted,
    ).toHaveLength(1);
  });

  test("неоднозначное название не угадывается", () => {
    const ambiguous = fbBasisClassifier(
      { mode: "selected", selected: ["4"], revision: 1 },
      [
        { service_id: "4", name: "Пробное занятие" },
        { service_id: "9", name: "Пробное занятие" },
      ],
      [],
    );
    expect(fbEvidenceDecide(owner, look(), [ev()], ambiguous, 1).counts.unknown_label).toBe(1);
    const auto = fbBasisClassifier({ mode: "auto", selected: [], revision: 1 }, [], []);
    expect(fbEvidenceDecide(owner, look(), [ev()], auto, 1).counts.unknown_label).toBe(1);
  });
});
