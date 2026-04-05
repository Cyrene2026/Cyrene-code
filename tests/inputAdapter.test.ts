import { describe, expect, test } from "bun:test";
import {
  normalizeRawInputChunk,
  shouldDispatchRawInputEvent,
} from "../src/application/chat/inputAdapter";

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

  test("raw stdin dispatch ignores plain printable characters that ink already handles", () => {
    expect(
      shouldDispatchRawInputEvent({
        input: "你",
        key: {
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: false,
          escape: false,
          ctrl: false,
          shift: false,
          tab: false,
          backspace: false,
          delete: false,
          meta: false,
        },
      })
    ).toBe(false);
  });

  test("raw stdin dispatch still allows multiline paste and control chords", () => {
    expect(
      shouldDispatchRawInputEvent({
        input: "第一行\n第二行",
        key: {
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: false,
          escape: false,
          ctrl: false,
          shift: false,
          tab: false,
          backspace: false,
          delete: false,
          meta: false,
        },
      })
    ).toBe(true);

    expect(
      shouldDispatchRawInputEvent({
        input: "d",
        key: {
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: false,
          escape: false,
          ctrl: true,
          shift: false,
          tab: false,
          backspace: false,
          delete: false,
          meta: false,
        },
      })
    ).toBe(true);
  });

  test("raw stdin dispatch leaves ordinary navigation keys to ink to avoid duplicate edits", () => {
    expect(
      shouldDispatchRawInputEvent({
        input: "",
        key: {
          upArrow: true,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: false,
          escape: false,
          ctrl: false,
          shift: false,
          tab: false,
          backspace: false,
          delete: false,
          meta: false,
        },
      })
    ).toBe(false);

    expect(
      shouldDispatchRawInputEvent({
        input: "",
        key: {
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: true,
          escape: false,
          ctrl: false,
          shift: false,
          tab: false,
          backspace: false,
          delete: false,
          meta: false,
        },
      })
    ).toBe(false);
  });

  test("raw stdin dispatch keeps backspace/delete available as a platform fallback", () => {
    expect(
      shouldDispatchRawInputEvent({
        input: "",
        key: {
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: false,
          escape: false,
          ctrl: false,
          shift: false,
          tab: false,
          backspace: true,
          delete: false,
          meta: false,
        },
      })
    ).toBe(true);

    expect(
      shouldDispatchRawInputEvent({
        input: "",
        key: {
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: false,
          escape: false,
          ctrl: false,
          shift: false,
          tab: false,
          backspace: false,
          delete: true,
          meta: false,
        },
      })
    ).toBe(true);
  });
});
