import { describe, expect, test } from "bun:test";
import { normalizeRawInputChunk } from "../src/application/chat/inputAdapter";

describe("inputAdapter", () => {
  test("normalizes common approval hotkeys from raw stdin chunks", () => {
    expect(normalizeRawInputChunk("a")).toEqual({
      input: "a",
      key: expect.objectContaining({
        ctrl: false,
        return: false,
      }),
    });

    expect(normalizeRawInputChunk("r")).toEqual({
      input: "r",
      key: expect.objectContaining({
        ctrl: false,
        return: false,
      }),
    });

    expect(normalizeRawInputChunk("\r")).toEqual({
      input: "",
      key: expect.objectContaining({
        return: true,
      }),
    });
  });

  test("normalizes arrow and paging escape sequences", () => {
    expect(normalizeRawInputChunk("\u001b[A")).toEqual({
      input: "",
      key: expect.objectContaining({
        upArrow: true,
      }),
    });

    expect(normalizeRawInputChunk("\u001b[B")).toEqual({
      input: "",
      key: expect.objectContaining({
        downArrow: true,
      }),
    });

    expect(normalizeRawInputChunk("\u001b[5~")).toEqual({
      input: "",
      key: expect.objectContaining({
        pageUp: true,
      }),
    });
  });

  test("normalizes ctrl key combinations", () => {
    expect(normalizeRawInputChunk("\u0001")).toEqual({
      input: "a",
      key: expect.objectContaining({
        ctrl: true,
      }),
    });

    expect(normalizeRawInputChunk("\u0012")).toEqual({
      input: "r",
      key: expect.objectContaining({
        ctrl: true,
      }),
    });

    expect(normalizeRawInputChunk("\u0004")).toEqual({
      input: "d",
      key: expect.objectContaining({
        ctrl: true,
      }),
    });
  });

  test("preserves multiline paste chunks instead of collapsing them into enter", () => {
    expect(normalizeRawInputChunk("first line\nsecond line")).toEqual({
      input: "first line\nsecond line",
      key: expect.objectContaining({
        return: false,
        ctrl: false,
      }),
    });
  });
});
