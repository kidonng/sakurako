import { describe, expect, it } from "bun:test";
import { formatDanbooruTitle } from "../../../src/features/danbooru/DanbooruFormatter.ts";

describe("formatDanbooruTitle", () => {
  it("formats character, copyright, and artist correctly", () => {
    const post = {
      id: 12345,
      tag_string_character: "reisen_udongein_inaba",
      tag_string_copyright: "touhou",
      tag_string_artist: "nacht_musik",
    };
    expect(formatDanbooruTitle(post)).toBe(
      "reisen udongein inaba (touhou) drawn by nacht musik",
    );
  });

  it("handles multiple characters and copyrights with 'more' suffix", () => {
    const post = {
      id: 12345,
      tag_string_character: "char1 char2 char3 char4 char5 char6",
      tag_string_copyright: "copy1 copy2",
      tag_string_artist: "artist1 artist2",
    };
    expect(formatDanbooruTitle(post)).toBe(
      "char1, char2, char3, char4, char5, and 1 more (copy1 and 1 more) drawn by artist1 and artist2",
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
    ).toBe("drawn by kantoku");
    expect(
      formatDanbooruTitle({
        id: 999,
        tag_string_character: "",
        tag_string_copyright: "",
        tag_string_artist: "",
      }),
    ).toBe("#999");
  });
});
