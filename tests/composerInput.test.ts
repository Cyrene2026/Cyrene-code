import { describe, expect, test } from "bun:test";
import { resolveComposerInputIntent } from "../src/application/chat/composerInput";
import { createEmptyInputKeyState } from "../src/application/chat/inputTypes";

describe("composerInput", () => {
  test("standard keymap keeps enter as submit and shift+enter as newline", () => {
    const enterKey = createEmptyInputKeyState();
    enterKey.return = true;

    const shiftEnterKey = createEmptyInputKeyState();
    shiftEnterKey.return = true;
    shiftEnterKey.shift = true;

    expect(resolveComposerInputIntent("", enterKey, "standard")).toEqual({
      kind: "submit",
    });
    expect(resolveComposerInputIntent("", shiftEnterKey, "standard")).toEqual({
      kind: "insert_newline",
    });
  });

  test("compat keymap turns enter into newline but keeps ctrl+d submit", () => {
    const enterKey = createEmptyInputKeyState();
    enterKey.return = true;

    const ctrlDKey = createEmptyInputKeyState();
    ctrlDKey.ctrl = true;

    expect(resolveComposerInputIntent("", enterKey, "compat")).toEqual({
      kind: "insert_newline",
    });
    expect(resolveComposerInputIntent("d", ctrlDKey, "compat")).toEqual({
      kind: "submit",
    });
  });

  test("ctrl+j and plain text stay adapter-agnostic", () => {
    const ctrlJKey = createEmptyInputKeyState();
    ctrlJKey.ctrl = true;

    expect(resolveComposerInputIntent("j", ctrlJKey, "standard")).toEqual({
      kind: "insert_newline",
    });
    expect(
      resolveComposerInputIntent("hello", createEmptyInputKeyState(), "standard")
    ).toEqual({
      kind: "insert_text",
      text: "hello",
    });
  });
});
