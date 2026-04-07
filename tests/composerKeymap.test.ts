import { describe, expect, test } from "bun:test";
import {
  getComposerHint,
  resolveComposerKeymap,
} from "../src/application/chat/composerKeymap";

describe("composerKeymap", () => {
  test("defaults to compat inside Windows Terminal unless explicitly overridden", () => {
    expect(
      resolveComposerKeymap({
        WT_SESSION: "1",
      })
    ).toBe("compat");

    expect(
      resolveComposerKeymap({
        WT_SESSION: "1",
        CYRENE_COMPOSER_KEYS: "standard",
      })
    ).toBe("standard");
  });

  test("keeps standard mode for terminals with known enhanced keyboard support", () => {
    expect(
      resolveComposerKeymap({
        WT_SESSION: "1",
        TERM_PROGRAM: "WezTerm",
      })
    ).toBe("standard");

    expect(
      resolveComposerKeymap({
        TERM: "xterm-kitty",
      })
    ).toBe("standard");
  });

  test("returns stable helper text for both keymaps", () => {
    expect(getComposerHint("standard")).toContain("Shift+Enter if terminal supports it");
    expect(getComposerHint("compat")).toContain("Ctrl+D send");
  });
});
