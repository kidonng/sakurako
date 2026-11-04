import { describe, expect, it } from "bun:test";
import { formatDanbooruTitle } from "../../../src/features/danbooru/DanbooruFormatter.ts";

describe("formatDanbooruTitle", () => {
  it("formats single character with series stripped and put into copyright", () => {
    const translations = new Map([
      ["moriya_suwako", "泄矢诹访子（东方Project）"],
      ["touhou", "东方Project"],
      ["moni_monico", "moni_monico"],
    ]);
    const title = formatDanbooruTitle(
      {
        id: 12459835,
        tag_string_character: "moriya_suwako",
        tag_string_copyright: "touhou",
        tag_string_artist: "moni_monico",
      },
      translations,
    );
    expect(title).toBe("泄矢诹访子 (东方Project) 画师 moni_monico");
  });

  it("formats multiple characters of the same series with series stripped", () => {
    const translations = new Map([
      ["kuramoto_china", "仓本千奈（学园偶像大师）"],
      ["shinosawa_hiro", "篠泽广（学园偶像大师）"],
      ["gakuen_idolmaster", "学园偶像大师"],
      ["idolmaster", "偶像大师"],
    ]);
    const title = formatDanbooruTitle(
      {
        id: 12509458,
        tag_string_character: "kuramoto_china shinosawa_hiro",
        tag_string_copyright: "gakuen_idolmaster idolmaster",
        tag_string_artist: "kousuke0912",
      },
      translations,
    );
    expect(title).toBe(
      "仓本千奈、篠泽广 (学园偶像大师 等 1 部) 画师 kousuke0912",
    );
  });

  it("retains character series suffix when characters belong to different series", () => {
    const translations = new Map([
      ["hakurei_reimu", "博丽灵梦（东方Project）"],
      ["mona", "莫娜（原神）"],
      ["touhou", "东方Project"],
      ["genshin_impact", "原神"],
    ]);
    const title = formatDanbooruTitle(
      {
        id: 99999,
        tag_string_character: "hakurei_reimu mona",
        tag_string_copyright: "touhou genshin_impact",
        tag_string_artist: "artist_a",
      },
      translations,
    );
    expect(title).toBe(
      "博丽灵梦（东方Project）、莫娜（原神） (东方Project 等 1 部) 画师 artist_a",
    );
  });

  it("formats original copyright with no character correctly", () => {
    const translations = new Map([["original", "原创"]]);
    const title = formatDanbooruTitle(
      {
        id: 88888,
        tag_string_character: "",
        tag_string_copyright: "original",
        tag_string_artist: "artist_b",
      },
      translations,
    );
    expect(title).toBe("原创 画师 artist_b");
  });

  it("handles more than 5 characters with '等 N 位'", () => {
    const translations = new Map([
      ["c1", "角色1（作品）"],
      ["c2", "角色2（作品）"],
      ["c3", "角色3（作品）"],
      ["c4", "角色4（作品）"],
      ["c5", "角色5（作品）"],
      ["c6", "角色6（作品）"],
      ["copy", "作品"],
    ]);
    const title = formatDanbooruTitle(
      {
        id: 77777,
        tag_string_character: "c1 c2 c3 c4 c5 c6",
        tag_string_copyright: "copy",
        tag_string_artist: "artist_c",
      },
      translations,
    );
    expect(title).toBe(
      "角色1、角色2、角色3、角色4、角色5 等 1 位 (作品) 画师 artist_c",
    );
  });

  it("omits empty components and falls back to #id when tags are blank", () => {
    expect(
      formatDanbooruTitle({
        id: 999,
        tag_string_character: "",
        tag_string_copyright: "",
        tag_string_artist: "kantoku",
      }),
    ).toBe("画师 kantoku");
    expect(
      formatDanbooruTitle({
        id: 999,
        tag_string_character: "",
        tag_string_copyright: "",
        tag_string_artist: "",
      }),
    ).toBe("#999");
  });

  it("falls back gracefully to tag names when translations map is omitted", () => {
    const title = formatDanbooruTitle({
      id: 12459835,
      tag_string_character: "moriya_suwako",
      tag_string_copyright: "touhou",
      tag_string_artist: "moni_monico",
    });
    expect(title).toBe("moriya suwako (touhou) 画师 moni_monico");
  });

  it("strips redundant artist category suffix from artist translations", () => {
    const translations = new Map([
      ["tandohark", "tandohark（画师）"],
      ["akari_ryuryuwa", "Akari_Ryuryuwa (画师)"],
    ]);
    const title = formatDanbooruTitle(
      {
        id: 3512237,
        tag_string_character: "",
        tag_string_copyright: "original",
        tag_string_artist: "tandohark akari_ryuryuwa",
      },
      translations,
    );
    expect(title).toBe("original 画师 tandohark、Akari_Ryuryuwa");
  });

  it("strips series suffix from characters when all characters with a series share the same series", () => {
    const translations = new Map([
      ["index_(toaru_majutsu_no_index)", "茵蒂克丝（魔法禁书目录）"],
      ["misaka_imouto", "御坂妹妹（魔法禁书目录）"],
      ["misaka_mikoto", "御坂美琴（魔法禁书目录）"],
      ["nyandex", "Nyandex"],
      ["shirai_kuroko", "白井黑子（魔法禁书目录）"],
      ["toaru_majutsu_no_index", "魔法禁书目录"],
      ["akari_ryuryuwa", "Akari_Ryuryuwa（画师）"],
    ]);
    const title = formatDanbooruTitle(
      {
        id: 560660,
        tag_string_character:
          "index_(toaru_majutsu_no_index) misaka_imouto misaka_mikoto nyandex shirai_kuroko",
        tag_string_copyright: "toaru_majutsu_no_index",
        tag_string_artist: "akari_ryuryuwa",
      },
      translations,
    );
    expect(title).toBe(
      "茵蒂克丝、御坂妹妹、御坂美琴、Nyandex、白井黑子 (魔法禁书目录) 画师 Akari_Ryuryuwa",
    );
  });
});
