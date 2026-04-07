import type { ComposerKeymap } from "./composerKeymap";
import type { InputKeyState } from "./inputTypes";

export type ComposerInputIntent =
  | { kind: "insert_newline" }
  | { kind: "submit" }
  | { kind: "insert_text"; text: string }
  | { kind: "none" };

export const resolveComposerInputIntent = (
  inputValue: string,
  key: InputKeyState,
  keymap: ComposerKeymap
): ComposerInputIntent => {
  if (key.return && key.shift) {
    return { kind: "insert_newline" };
  }

  if (key.return) {
    return keymap === "compat"
      ? { kind: "insert_newline" }
      : { kind: "submit" };
  }

  if (key.ctrl && inputValue.toLowerCase() === "j") {
    return { kind: "insert_newline" };
  }

  if (key.ctrl && inputValue.toLowerCase() === "d") {
    return { kind: "submit" };
  }

  if (inputValue && !key.ctrl && !key.meta) {
    return {
      kind: "insert_text",
      text: inputValue,
    };
  }

  return { kind: "none" };
};
