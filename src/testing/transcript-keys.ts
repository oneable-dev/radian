import type { MockInput } from "@opentui/core/testing";
import { defaultKeymap, type Keymap } from "../keybindings/config.ts";

type Input = { mockInput: MockInput };

function pressChord(app: Input, chord: string): void {
  const parts = chord.split("+");
  const name = parts.pop()!;
  const names: Record<string, string> = {
    space: " ",
    plus: "+",
    return: "RETURN",
    escape: "ESCAPE",
    tab: "TAB",
    backspace: "BACKSPACE",
    home: "HOME",
    end: "END",
    up: "ARROW_UP",
    down: "ARROW_DOWN",
    left: "ARROW_LEFT",
    right: "ARROW_RIGHT",
  };

  app.mockInput.pressKey(names[name] ?? (/^f\d+$/u.test(name) ? name.toUpperCase() : name), {
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    meta: parts.includes("alt"),
    super: parts.includes("super"),
  });
}

export function pressLeader(app: Input, key: string, keymap = defaultKeymap()): void {
  for (const chord of keymap.leader) {
    pressChord(app, chord);
  }

  pressChord(app, key);
}

// Exercise the actual configured entry command, not a test-only legacy alias.
// The transcript feature can be tested independently of the shared output-reader
// keymap migration used by the Terminal view.
export function pressTranscriptRead(app: Input, keymap: Keymap = defaultKeymap()): void {
  const binding =
    keymap.bindings.find((binding) => String(binding.command) === "output.read") ??
    keymap.bindings.find((binding) => binding.command === "focus.transcript");
  if (!binding) {
    throw new Error("No configured transcript entry command");
  }
  for (const chord of binding.keys) {
    pressChord(app, chord);
  }
}
