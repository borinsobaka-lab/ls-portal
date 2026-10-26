import { describe, expect, test } from "bun:test";

import { parseKbEmbed } from "./embed";

const src = (r: ReturnType<typeof parseKbEmbed>) => ("src" in r ? r.src : r.error);

describe("parseKbEmbed", () => {
  test("RuTube: обычная, shorts, закрытая с ключом, код для вставки", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const rt = `https://rutube.ru/play/embed/${id}/`;
    expect(src(parseKbEmbed("rutube", `https://rutube.ru/video/${id}/`))).toBe(rt);
    expect(src(parseKbEmbed("rutube", `rutube.ru/video/${id}/?r=wd&t=95`))).toBe(`${rt}?t=95`);
    expect(src(parseKbEmbed("rutube", `https://rutube.ru/shorts/${id}/`))).toBe(rt);
    expect(src(parseKbEmbed("rutube", `https://rutube.ru/video/private/${id}/?p=AbC-123`))).toBe(
      `${rt}?p=AbC-123`,
    );
    expect(
      src(
        parseKbEmbed(
          "rutube",
          `<iframe width="720" src="https://rutube.ru/play/embed/${id}" frameBorder="0" allow="clipboard-write; autoplay" allowFullScreen></iframe>`,
        ),
      ),
    ).toBe(rt);
  });

  test("Kinescope: ссылка и код для вставки", () => {
    expect(src(parseKbEmbed("kinescope", "https://kinescope.io/oZmzYmVfEFsbHdA8Bp5yTV"))).toBe(
      "https://kinescope.io/embed/oZmzYmVfEFsbHdA8Bp5yTV",
    );
    expect(
      src(
        parseKbEmbed(
          "kinescope",
          '<iframe src="https://kinescope.io/embed/abc123?autoplay=1" allow="autoplay"></iframe>',
        ),
      ),
    ).toBe("https://kinescope.io/embed/abc123?autoplay=1");
  });

  test("VK Видео: ссылка, ?z=, код с hash", () => {
    const vk = "https://vkvideo.ru/video_ext.php?oid=-123456&id=456239017&hd=2";
    expect(src(parseKbEmbed("vk", "https://vkvideo.ru/video-123456_456239017"))).toBe(vk);
    expect(src(parseKbEmbed("vk", "https://vk.com/club1?z=video-123456_456239017%2Fpl"))).toBe(vk);
    expect(
      src(
        parseKbEmbed(
          "vk",
          '<iframe src="https://vk.com/video_ext.php?oid=-123456&id=456239017&hash=ab12cd&hd=2" allowfullscreen></iframe>',
        ),
      ),
    ).toBe("https://vkvideo.ru/video_ext.php?oid=-123456&id=456239017&hash=ab12cd&hd=2");
  });

  test("iframe: любой https, известный сервис узнаётся сам", () => {
    expect(
      src(parseKbEmbed("iframe", '<iframe src="https://player.vimeo.com/video/1"></iframe>')),
    ).toBe("https://player.vimeo.com/video/1");
    const r = parseKbEmbed("iframe", "https://rutube.ru/video/0123456789abcdef0123456789abcdef/");
    expect("provider" in r && r.provider).toBe("rutube");
    expect("error" in parseKbEmbed("iframe", "http://example.com/x")).toBe(true);
    expect(
      "error" in parseKbEmbed("iframe", "https://portal.example/kb", "https://portal.example"),
    ).toBe(true);
  });

  test("не та ссылка — ошибка с примером", () => {
    expect("error" in parseKbEmbed("rutube", "https://example.com/video")).toBe(true);
    expect("error" in parseKbEmbed("rutube", "https://rutube.ru/channel/123/")).toBe(true);
    expect("error" in parseKbEmbed("vk", "https://vkvideo.ru/")).toBe(true);
    expect("error" in parseKbEmbed("rutube", "  ")).toBe(true);
    expect("error" in parseKbEmbed("kinescope", "<iframe></iframe>")).toBe(true);
  });
});

describe("блок видео с сервиса в документе", () => {
  test("в «Что изменилось» — подпись или адрес, статья не пустая", async () => {
    const { documentLines, documentIsEmpty } = await import("./document");
    const doc = [
      {
        id: "e",
        type: "embed",
        props: {
          provider: "rutube",
          url: "https://rutube.ru/play/embed/x/",
          caption: "",
        },
        children: [],
      },
    ];
    expect(documentLines(doc)[0].text).toBe("Видео с сервиса: https://rutube.ru/play/embed/x/");
    expect(documentIsEmpty(doc)).toBe(false);
  });
});
