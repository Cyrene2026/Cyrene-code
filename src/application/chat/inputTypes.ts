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

export type InputHandler = (input: string, key: InputKeyState) => void;

export type InputAdapterOptions = {
  isActive?: boolean;
};

export type InputAdapterHook = (
  handler: InputHandler,
  options?: InputAdapterOptions
) => void;

export type NormalizedInputEvent = {
  input: string;
  key: InputKeyState;
};

export const createEmptyInputKeyState = (): InputKeyState => ({
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
