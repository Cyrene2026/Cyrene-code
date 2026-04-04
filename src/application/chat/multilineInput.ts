export type MultilineEditorState = {
  value: string;
  cursorOffset: number;
};

export type CursorPosition = {
  line: number;
  column: number;
};

type InputLineRange = {
  text: string;
  start: number;
  end: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const clampCursorOffset = (value: string, cursorOffset: number) =>
  clamp(cursorOffset, 0, value.length);

export const getInputLines = (value: string) => value.split("\n");

const getInputLineRanges = (value: string): InputLineRange[] => {
  const lines = getInputLines(value);
  const ranges: InputLineRange[] = [];
  let start = 0;

  for (const line of lines) {
    const end = start + line.length;
    ranges.push({ text: line, start, end });
    start = end + 1;
  }

  return ranges.length > 0 ? ranges : [{ text: "", start: 0, end: 0 }];
};

export const getCursorPosition = (
  value: string,
  cursorOffset: number
): CursorPosition => {
  const clamped = clampCursorOffset(value, cursorOffset);
  const ranges = getInputLineRanges(value);

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (clamped >= range.start && clamped <= range.end) {
      return {
        line: index,
        column: clamped - range.start,
      };
    }
  }

  const last = ranges[ranges.length - 1]!;
  return {
    line: ranges.length - 1,
    column: last.text.length,
  };
};

export const insertTextAtCursor = (
  state: MultilineEditorState,
  text: string
): MultilineEditorState => {
  if (!text) {
    return {
      value: state.value,
      cursorOffset: clampCursorOffset(state.value, state.cursorOffset),
    };
  }

  const cursorOffset = clampCursorOffset(state.value, state.cursorOffset);
  return {
    value:
      state.value.slice(0, cursorOffset) +
      text +
      state.value.slice(cursorOffset),
    cursorOffset: cursorOffset + text.length,
  };
};

export const deleteBackwardAtCursor = (
  state: MultilineEditorState
): MultilineEditorState => {
  const cursorOffset = clampCursorOffset(state.value, state.cursorOffset);
  if (cursorOffset === 0) {
    return {
      value: state.value,
      cursorOffset,
    };
  }

  return {
    value:
      state.value.slice(0, cursorOffset - 1) +
      state.value.slice(cursorOffset),
    cursorOffset: cursorOffset - 1,
  };
};

export const deleteForwardAtCursor = (
  state: MultilineEditorState
): MultilineEditorState => {
  const cursorOffset = clampCursorOffset(state.value, state.cursorOffset);
  if (cursorOffset >= state.value.length) {
    return {
      value: state.value,
      cursorOffset,
    };
  }

  return {
    value:
      state.value.slice(0, cursorOffset) +
      state.value.slice(cursorOffset + 1),
    cursorOffset,
  };
};

export const moveCursorLeft = (
  state: MultilineEditorState
): MultilineEditorState => ({
  value: state.value,
  cursorOffset: clampCursorOffset(state.value, state.cursorOffset - 1),
});

export const moveCursorRight = (
  state: MultilineEditorState
): MultilineEditorState => ({
  value: state.value,
  cursorOffset: clampCursorOffset(state.value, state.cursorOffset + 1),
});

export const moveCursorVertical = (
  state: MultilineEditorState,
  direction: "up" | "down",
  preferredColumn?: number | null
): {
  state: MultilineEditorState;
  preferredColumn: number;
} => {
  const cursorOffset = clampCursorOffset(state.value, state.cursorOffset);
  const ranges = getInputLineRanges(state.value);
  const current = getCursorPosition(state.value, cursorOffset);
  const desiredColumn = preferredColumn ?? current.column;
  const nextLineIndex =
    direction === "up"
      ? Math.max(0, current.line - 1)
      : Math.min(ranges.length - 1, current.line + 1);
  const nextLine = ranges[nextLineIndex]!;
  const nextColumn = Math.min(desiredColumn, nextLine.text.length);

  return {
    state: {
      value: state.value,
      cursorOffset: nextLine.start + nextColumn,
    },
    preferredColumn: desiredColumn,
  };
};
