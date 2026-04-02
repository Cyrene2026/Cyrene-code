import { useEffect, useMemo, useRef } from "react";
import { useInput, useStdin } from "ink";

export type InputKeyState = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
};

type InputHandler = (input: string, key: InputKeyState) => void;

type InputAdapterOptions = {
  isActive?: boolean;
};

type NormalizedInputEvent = {
  input: string;
  key: InputKeyState;
};

const emptyKeyState = (): InputKeyState => ({
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
});

const buildSignature = (event: NormalizedInputEvent) =>
  `${event.input}::${JSON.stringify(event.key)}`;

const isCtrlCharacter = (raw: string) =>
  raw.length === 1 && raw.charCodeAt(0) > 0 && raw.charCodeAt(0) <= 26;

export const normalizeRawInputChunk = (
  chunk: Buffer | string
): NormalizedInputEvent | null => {
  const raw = chunk.toString();
  const key = emptyKeyState();

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

  handlerRef.current = handler;

  const dispatch = useMemo(
    () => (event: NormalizedInputEvent) => {
      const signature = buildSignature(event);
      const now = Date.now();
      const last = lastEventRef.current;

      if (last && last.signature === signature && now - last.timestamp < 32) {
        return;
      }

      lastEventRef.current = {
        signature,
        timestamp: now,
      };
      handlerRef.current(event.input, event.key);
    },
    []
  );

  useInput(
    (input, key) => {
      dispatch({
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

    const onData = (data: Buffer | string) => {
      const normalized = normalizeRawInputChunk(data);
      if (normalized) {
        dispatch(normalized);
      }
    };

    stdin.on("data", onData);

    return () => {
      stdin.off("data", onData);
      if (isRawModeSupported) {
        setRawMode(false);
      }
    };
  }, [dispatch, isActive, isRawModeSupported, setRawMode, stdin]);
};
