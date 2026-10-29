import {
  VimText,
  maximumVimCount,
  type VimFind,
  type VimMotion,
  type VimMove,
  type VimRange,
} from "./transcript-vim-text.ts";

export type VimContext = { model: VimText; cursor: number; visual: boolean };

export type VimEffect =
  | { type: "none" }
  | { type: "move"; position: number }
  | { type: "native"; motion: "up" | "down"; count: number }
  | { type: "select" | "yank"; range: VimRange }
  | { type: "copy-selection" }
  | { type: "notice"; message: string };

export type VimAction =
  | VimMotion
  | "yank"
  | "inner"
  | "around"
  | "find-forward"
  | "find-backward"
  | "till-forward"
  | "till-backward"
  | "find-repeat"
  | "find-reverse";

const none: VimEffect = { type: "none" };
const bounded = (value: number) => Math.min(maximumVimCount, Math.max(1, value));
const findKinds = {
  "find-forward": "f",
  "find-backward": "F",
  "till-forward": "t",
  "till-backward": "T",
} as const;

// Owns only unfinished read commands. It never changes text, focus, the clipboard
// or saved conversations. The host applies effects through the shared command map.
export class TranscriptVim {
  private digits = "";
  private counting = false;
  private operator: { count: number } | undefined;
  private object: { around: boolean } | undefined;
  private find: { kind: VimFind["kind"]; count: number } | undefined;
  private lastFind: VimFind | undefined;
  private lastFindStep: { kind: VimFind["kind"]; position: number } | undefined;

  get pending(): boolean {
    return this.counting || !!this.operator || !!this.object || !!this.find;
  }

  get awaitingCharacter(): boolean {
    return !!this.object || !!this.find;
  }

  get status(): string {
    return (
      (this.operator ? (this.operator.count > 1 ? this.operator.count : "") + "y" : "") +
      this.digits +
      (this.object ? (this.object.around ? "a" : "i") : (this.find?.kind ?? "")) +
      (this.counting && !this.digits ? "…" : "")
    );
  }

  cancel(): void {
    this.digits = "";
    this.counting = false;
    this.operator = undefined;
    this.object = undefined;
    this.find = undefined;
  }

  digit(digit: string): void {
    this.counting = true;
    if (/^[0-9]$/u.test(digit)) {
      this.digits = String(Math.min(maximumVimCount, Number(this.digits + digit)));
    }
  }

  get hasCount(): boolean {
    return this.counting;
  }

  private count(): { count: number; explicit: boolean } {
    const result = {
      count: bounded((this.operator?.count ?? 1) * (Number(this.digits) || 1)),
      explicit: this.counting,
    };
    this.digits = "";
    this.counting = false;

    return result;
  }

  private finish(effect: VimEffect): VimEffect {
    this.cancel();

    return effect;
  }

  private moved(context: VimContext, move: VimMove | null): VimEffect {
    if (!move) {
      return this.finish({ type: "notice", message: "No matching text" });
    }

    return this.finish(
      this.operator
        ? { type: "yank", range: context.model.motionRange(context.cursor, move) }
        : { type: "move", position: move.position },
    );
  }

  command(action: VimAction, context: VimContext): VimEffect {
    if (action === "yank") {
      if (context.visual) {
        return this.finish({ type: "copy-selection" });
      }
      if (this.operator) {
        const { count } = this.count();
        const line = context.model.line(context.cursor);

        return this.finish({
          type: "yank",
          range: context.model.lineRange(
            line,
            Math.min(context.model.lines.length - 1, line + count - 1),
          ),
        });
      }

      const { count } = this.count();
      this.operator = { count };

      return none;
    }
    if (action === "inner" || action === "around") {
      if (!context.visual && !this.operator) {
        return this.finish(none);
      }

      this.object = { around: action === "around" };

      return none;
    }
    if (
      action === "find-forward" ||
      action === "find-backward" ||
      action === "till-forward" ||
      action === "till-backward"
    ) {
      const { count } = this.count();
      this.find = { kind: findKinds[action], count };

      return none;
    }
    if (action === "find-repeat" || action === "find-reverse") {
      const { count } = this.count();
      if (!this.lastFind) {
        return this.finish({ type: "notice", message: "No previous character find" });
      }

      const reverse = { f: "F", F: "f", t: "T", T: "t" } as const;
      const kind = action === "find-reverse" ? reverse[this.lastFind.kind] : this.lastFind.kind;
      const repeat =
        this.lastFindStep?.kind === kind && this.lastFindStep.position === context.cursor;
      const move = context.model.find(context.cursor, { ...this.lastFind, kind, repeat }, count);
      if (move) {
        this.lastFindStep = { kind, position: move.position };
      }

      return this.moved(context, move);
    }

    const { count, explicit } = this.count();
    if ((action === "up" || action === "down") && !this.operator) {
      return this.finish({ type: "native", motion: action, count });
    }

    return this.moved(context, context.model.move(context.cursor, action, count, explicit));
  }

  character(character: string, context: VimContext): VimEffect {
    if (this.object) {
      const { count } = this.count();
      const range = context.model.object(context.cursor, character, this.object.around, count);

      return this.finish(
        range
          ? { type: this.operator ? "yank" : "select", range }
          : { type: "notice", message: "No matching text object" },
      );
    }
    if (this.find) {
      const { kind, count } = this.find;
      this.lastFind = { kind, character };

      const move = context.model.find(context.cursor, this.lastFind, count);
      this.lastFindStep = move ? { kind, position: move.position } : undefined;

      return this.moved(context, move);
    }

    return this.finish(none);
  }
}
