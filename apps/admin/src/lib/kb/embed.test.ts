import { describe, expect, test } from "bun:test";

import { parseKbEmbed } from "./embed";

const src = (r: ReturnType<typeof parseKbEmbed>) => ("src" in r ? r.src : r.error);

describe("parseKbEmbed", () => {
  test("YouTube: обычная, короткая, shorts, встраивание, время начала", () => {
    const yt = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0";
    expect(src(parseKbEmbed("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))).toBe(yt);
    expect(src(parseKbEmbed("youtube", "youtu.be/dQw4w9WgXcQ?si=abc"))).toBe(yt);
    expect(src(parseKbEmbed("youtube", "https://youtube.com/shorts/dQw4w9WgXcQ"))).toBe(yt);
    expect(src(parseKbEmbed("youtube", "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s"))).toBe(
      `${yt}&start=90`,
    );
    expect(
      src(
        parseKbEmbed(
          "youtube",
          '<iframe width="560" src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=x&amp;start=5" allowfullscreen></iframe>',
        ),
      ),
    ).toBe(`${yt}&start=5`);
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
      src(parseKbEmbed("iframe", '<iframe src="https://rutube.ru/play/embed/abc"></iframe>')),
    ).toBe("https://rutube.ru/play/embed/abc");
    const r = parseKbEmbed("iframe", "https://youtu.be/dQw4w9WgXcQ");
    expect("provider" in r && r.provider).toBe("youtube");
    expect("error" in parseKbEmbed("iframe", "http://example.com/x")).toBe(true);
    expect(
      "error" in parseKbEmbed("iframe", "https://portal.example/kb", "https://portal.example"),
    ).toBe(true);
  });

  test("не та ссылка — ошибка с примером", () => {
    expect("error" in parseKbEmbed("youtube", "https://example.com/video")).toBe(true);
    expect("error" in parseKbEmbed("vk", "https://vkvideo.ru/")).toBe(true);
    expect("error" in parseKbEmbed("youtube", "  ")).toBe(true);
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
          provider: "youtube",
          url: "https://www.youtube-nocookie.com/embed/x",
          caption: "",
        },
        children: [],
      },
    ];
    expect(documentLines(doc)[0].text).toBe(
      "Видео с сервиса: https://www.youtube-nocookie.com/embed/x",
    );
    expect(documentIsEmpty(doc)).toBe(false);
  });
});
