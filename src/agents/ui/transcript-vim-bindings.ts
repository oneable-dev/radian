import type { KeyEvent } from "@opentui/core";
import type { CommandId } from "../../keybindings/commands.ts";
import type { VimAction } from "../transcript-vim.ts";

const actions = {
  "transcript.left": "left",
  "transcript.right": "right",
  "transcript.up": "up",
  "transcript.down": "down",
  "transcript.word-next": "word-next",
  "transcript.word-previous": "word-previous",
  "transcript.word-end": "word-end",
  "transcript.big-word-next": "WORD-next",
  "transcript.big-word-previous": "WORD-previous",
  "transcript.big-word-end": "WORD-end",
  "transcript.line-start": "line-start",
  "transcript.line-first-nonblank": "line-first-nonblank",
  "transcript.line-end": "line-end",
  "transcript.buffer-start": "buffer-start",
  "transcript.buffer-end": "buffer-end",
  "transcript.copy": "yank",
  "transcript.inner-object": "inner",
  "transcript.around-object": "around",
  "transcript.find-forward": "find-forward",
  "transcript.find-backward": "find-backward",
  "transcript.till-forward": "till-forward",
  "transcript.till-backward": "till-backward",
  "transcript.find-repeat": "find-repeat",
  "transcript.find-reverse": "find-reverse",
} satisfies Partial<Record<CommandId, VimAction>>;

export function transcriptVimAction(command: CommandId): VimAction | undefined {
  return command in actions ? actions[command as keyof typeof actions] : undefined;
}

const prefixCommands: Readonly<Record<string, CommandId>> = {
  y: "transcript.copy",
  i: "transcript.inner-object",
  a: "transcript.around-object",
  f: "transcript.find-forward",
  F: "transcript.find-backward",
  t: "transcript.till-forward",
  T: "transcript.till-backward",
};

export function vimPendingHint(status: string, hint: (command: CommandId) => string): string {
  return status.replace(
    /[yiafFtT]/gu,
    (prefix) =>
      hint(prefixCommands[prefix]!) || `[${prefixCommands[prefix]!.slice("transcript.".length)}]`,
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const shifted: Readonly<Record<string, string>> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "-": "_",
  "=": "+",
  "`": "~",
};

// Character arguments are literal data, even when the same key normally runs a
// command (fw, fiw, etc.). Kitty reports base keys plus Shift; legacy input often
// reports the resulting printable character instead.
export function vimCharacter(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option || key.super) {
    return null;
  }
  if (key.name === "space") {
    return " ";
  }
  if (key.name === "tab" && !key.shift) {
    return "\t";
  }

  const value = key.shift
    ? (shifted[key.name] ?? (/^[a-z]$/u.test(key.name) ? key.name.toUpperCase() : key.name))
    : key.name;

  return [...segmenter.segment(value)].length === 1 ? value : null;
}
