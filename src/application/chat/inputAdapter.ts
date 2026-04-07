import { useEffect, useMemo, useRef } from "react";
import { useInput, useStdin } from "ink";
import {
  createEmptyInputKeyState,
  type InputAdapterOptions,
  type InputHandler,
  type InputKeyState,
  type NormalizedInputEvent,
} from "./inputTypes";

type DispatchableInputEvent = NormalizedInputEvent & {
  source: "ink" | "raw";
};

const buildSignature = (event: NormalizedInputEvent) =>
  `${event.input}::${JSON.stringify(event.key)}`;

const isCtrlCharacter = (raw: string) =>
  raw.length === 1 && raw.charCodeAt(0) > 0 && raw.charCodeAt(0) <= 26;

const hasSpecialKey = (key: InputKeyState) =>
  key.upArrow ||
  key.downArrow ||
  key.leftArrow ||
  key.rightArrow ||
  key.pageDown ||
  key.pageUp ||
  key.return ||
  key.escape ||
  key.ctrl ||
  key.shift ||
  key.tab ||
  key.backspace ||
  key.delete ||
  key.meta;

const SHIFT_ENTER_SEQUENCE_PATTERN =
  /^\u001b\[(?:13;2u|13;2~|27;2;13~|27;2;13u|1;2M)$/;
const ENABLE_MODIFY_OTHER_KEYS_SEQUENCE = "\u001b[>4;2m";
const DISABLE_MODIFY_OTHER_KEYS_SEQUENCE = "\u001b[>4;0m";

const shouldUseEnhancedKeyboardProtocol = () =>
  process.stdout.isTTY !== false &&
  process.env.CYRENE_ENABLE_ENHANCED_KEYS !== "0";

const shouldDebugKeyProtocol = () => process.env.CYRENE_DEBUG_KEYS === "1";

const formatRawChunkForDebug = (raw: string) => {
  const printable = raw
    .replace(/\u001b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  const bytes = Array.from(Buffer.from(raw))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join(" ");
  return `${printable} [${bytes}]`;
};

export const normalizeRawInputChunk = (
  chunk: Buffer | string
): NormalizedInputEvent | null => {
  const raw = chunk.toString();
  const key = createEmptyInputKeyState();

  if (SHIFT_ENTER_SEQUENCE_PATTERN.test(raw)) {
    key.return = true;
    key.shift = true;
    return { input: "", key };
  }

  switch (raw) {
    case "\u001b[A":
      key.upArrow = true;
      return { input: "", key };
    case "\u001b[B":
      key.downArrow = true;
      return { input: "", key };
    case "\u001b[D":
      key.leftArrow = true;
      return { input: "", key };
    case "\u001b[C":
      key.rightArrow = true;
      return { input: "", key };
    case "\u001b[5~":
      key.pageUp = true;
      return { input: "", key };
    case "\u001b[6~":
      key.pageDown = true;
      return { input: "", key };
    case "\r":
    case "\n":
      key.return = true;
      return { input: "", key };
    case "\u001b":
      key.escape = true;
      return { input: "", key };
    case "\t":
      key.tab = true;
      return { input: "", key };
    case "\b":
    case "\u007f":
      key.backspace = true;
      return { input: "", key };
    case "\u001b[3~":
      key.delete = true;
      return { input: "", key };
    default:
      break;
  }

  if (isCtrlCharacter(raw)) {
    key.ctrl = true;
    return {
      input: String.fromCharCode(raw.charCodeAt(0) + 96),
      key,
    };
  }

  if (raw.startsWith("\u001b") && raw.length === 2) {
    key.meta = true;
    return {
      input: raw.slice(1),
      key,
    };
  }

  if (raw.length > 0) {
    return {
      input: raw,
      key,
    };
  }

  return null;
};

export const shouldDispatchRawInputEvent = (event: NormalizedInputEvent) => {
  if (event.key.return && event.key.shift) {
    return true;
  }

  if (event.key.ctrl || event.key.meta) {
    return true;
  }

  if (event.key.backspace || event.key.delete) {
    return true;
  }

  if (!event.input) {
    return false;
  }

  return /[\r\n]/.test(event.input) && event.input.length > 1;
};

export const useInputAdapter = (
  handler: InputHandler,
  options?: InputAdapterOptions
) => {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const isActive = options?.isActive ?? true;
  const handlerRef = useRef(handler);
  const lastEventRef = useRef<{ signature: string; timestamp: number } | null>(
    null
  );
  const suppressInkPrintableUntilRef = useRef(0);

  handlerRef.current = handler;

  const dispatch = useMemo(
    () => (event: DispatchableInputEvent) => {
      const now = Date.now();

      if (
        event.source === "ink" &&
        now < suppressInkPrintableUntilRef.current &&
        event.input &&
        !hasSpecialKey(event.key) &&
        !event.key.ctrl &&
        !event.key.meta
      ) {
        return;
      }

      const signature = buildSignature(event);
      const last = lastEventRef.current;

      if (last && last.signature === signature && now - last.timestamp < 32) {
        return;
      }

      lastEventRef.current = {
        signature,
        timestamp: now,
      };

      if (event.source === "raw" && /[\r\n]/.test(event.input)) {
        suppressInkPrintableUntilRef.current = now + 120;
      }

      handlerRef.current(event.input, event.key);
    },
    []
  );

  useInput(
    (input, key) => {
      dispatch({
        source: "ink",
        input,
        key: {
          upArrow: key.upArrow,
          downArrow: key.downArrow,
          leftArrow: key.leftArrow,
          rightArrow: key.rightArrow,
          pageDown: key.pageDown,
          pageUp: key.pageUp,
          return: key.return,
          escape: key.escape,
          ctrl: key.ctrl,
          shift: key.shift,
          tab: key.tab,
          backspace: key.backspace,
          delete: key.delete,
          meta: key.meta,
        },
      });
    },
    { isActive }
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }

    if (isRawModeSupported) {
      setRawMode(true);
    }

    if (shouldUseEnhancedKeyboardProtocol()) {
      process.stdout.write(ENABLE_MODIFY_OTHER_KEYS_SEQUENCE);
    }

    const onData = (data: Buffer | string) => {
      const raw = data.toString();
      const normalized = normalizeRawInputChunk(raw);

      if (shouldDebugKeyProtocol() && /[\u001b\r\n]/.test(raw)) {
        const flags = normalized
          ? `return=${normalized.key.return} shift=${normalized.key.shift} ctrl=${normalized.key.ctrl} meta=${normalized.key.meta}`
          : "unrecognized";
        process.stderr.write(
          `[cyrene:keys] ${formatRawChunkForDebug(raw)} -> ${flags}\n`
        );
      }

      if (normalized && shouldDispatchRawInputEvent(normalized)) {
        dispatch({
          ...normalized,
          source: "raw",
        });
      }
    };

    stdin.on("data", onData);

    return () => {
      stdin.off("data", onData);
      if (shouldUseEnhancedKeyboardProtocol()) {
        process.stdout.write(DISABLE_MODIFY_OTHER_KEYS_SEQUENCE);
      }
      if (isRawModeSupported) {
        setRawMode(false);
      }
    };
  }, [dispatch, isActive, isRawModeSupported, setRawMode, stdin]);
};
