import type { Renderable } from "@opentui/core";

type Options = {
  linkAt(x: number, y: number): string | null | undefined;
  revision(): unknown;
  open(url: string): void;
};

// Intercept before EmbeddedTerminal forwards native mouse input. Option callbacks
// run too late to prevent a partial mouse gesture from reaching the program.
export function bindCtrlClickLink(root: Renderable, options: Options): void {
  const nativeMouse = root.processMouseEvent.bind(root),
    nativeSelection = root.onSelectionChanged.bind(root);
  let gesture = false,
    selecting = false;
  let press: { x: number; y: number; url: string; revision: unknown } | undefined;
  const arm = (x: number, y: number): void => {
    const url = options.linkAt(x, y);
    gesture = !!url;
    press = url ? { x, y, url, revision: options.revision() } : undefined;
  };
  root.onSelectionChanged = (selection) => {
    // OpenTUI consumes Ctrl-down to extend an existing selection without sending
    // a down event. Capture that transition too; activation still requires an
    // unchanged target and a Ctrl-up without any intervening drag.
    if (selection?.isDragging && !selection.isStart && !selecting)
      arm(selection.focus.x, selection.focus.y);
    selecting = selection?.isDragging ?? false;
    return nativeSelection(selection);
  };
  root.processMouseEvent = (event) => {
    const controlClick =
      event.button === 0 && event.modifiers.ctrl && !event.modifiers.alt && !event.modifiers.shift;
    if (event.type === "down") {
      gesture = false;
      press = undefined;
      if (controlClick) arm(event.x, event.y);
    }
    if (!gesture) {
      nativeMouse(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (
      event.type === "drag" ||
      (event.type === "move" && (event.x !== press?.x || event.y !== press?.y))
    )
      press = undefined;
    if (event.type !== "up") return;
    const accepted = press;
    press = undefined;
    gesture = false;
    if (
      accepted &&
      controlClick &&
      event.x === accepted.x &&
      event.y === accepted.y &&
      options.revision() === accepted.revision &&
      options.linkAt(event.x, event.y) === accepted.url
    )
      options.open(accepted.url);
  };
}
