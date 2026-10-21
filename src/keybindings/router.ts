import { EmbeddedTerminalRenderable, KeyEvent, type CliRenderer, type Renderable } from "@opentui/core";
import { inScope, type CommandId, type KeyContext } from "./commands.ts";
import { keyToken, type Binding, type Keymap } from "./config.ts";

const oneShot = new Set<CommandId>(["tab.new", "input.ignore", "search.clear", "monitor.open", "monitor.dismiss", "dashboard.show", "dashboard.dismiss", "dashboard.refresh", "workspace.dismiss", "workspace.open", "focus.results", "agent.send", "agent.clear", "git.clear", "completion.accept", "completion.dismiss", "history.open", "history.dismiss", "model.select", "model.dismiss", "model.search", "dialog.dismiss", "dialog.activate", "dialog.copy", "app.help", "agent.inspect", "git.inspect"]);
type Pending = { owner: Renderable | null; events: KeyEvent[]; keys: string[]; held: Set<string>; candidates: readonly Binding[] };
export class KeyRouter {
  private pending: Pending | undefined;
  private timer: ReturnType<CliRenderer["clock"]["setTimeout"]> | undefined;
  private readonly consumed = new Map<string, boolean>();
  private disposed = false;
  constructor(private readonly renderer: CliRenderer, readonly keymap: Keymap,
    private readonly context: () => KeyContext, private readonly available: (command: CommandId) => boolean,
    private readonly execute: (command: CommandId) => void) {
    renderer.keyInput.prependListener("keypress", this.press);
    renderer.keyInput.prependListener("keyrelease", this.release);
    renderer.keyInput.prependListener("paste", this.flush);
    renderer.on("focused_renderable", this.focusChanged);
  }
  private consume(key: KeyEvent): void { key.preventDefault(); key.stopPropagation(); }
  private press = (key: KeyEvent): void => {
    if (this.disposed) return;
    const repeated = key.eventType === "repeat" || key.repeated === true;
    if (repeated && this.consumed.get(key.name)) { this.consume(key); return; }
    if (!repeated) this.consumed.delete(key.name);
    const token = keyToken(key);
    if (!this.pending) {
      const candidates = this.keymap.bindings.filter((binding) => binding.keys[0] === token && inScope(binding.scope, this.context()));
      if (!candidates.length) return;
      this.pending = { owner: this.renderer.currentFocusedRenderable ?? null, events: [], keys: [], held: new Set(), candidates };
    }
    const pending = this.pending;
    this.consume(key);
    pending.events.push(new KeyEvent(key));
    if (repeated && pending.held.has(key.name)) return; // Preserve repetitions for a literal replay, not multiple app actions.
    pending.held.add(key.name); pending.keys.push(token);
    const candidates = pending.candidates.filter((binding) => binding.keys[pending.keys.length - 1] === token);
    const complete = candidates.find((binding) => binding.keys.length === pending.keys.length);
    if (complete) {
      this.clear();
      const once = complete.keys.length > 1 || oneShot.has(complete.command);
      // A held one-shot key must not resubmit or become a different action after its context changes.
      for (const name of pending.held) this.consumed.set(name, once);
      // A configured command with an unavailable target is still an app command.
      // Never turn a disabled close/focus action into literal edits in Neovim/a shell.
      if (this.available(complete.command)) this.execute(complete.command);
      return;
    }
    if (!candidates.length) { this.flush(); return; }
    pending.candidates = candidates;
    if (this.timer !== undefined) this.renderer.clock.clearTimeout(this.timer);
    this.timer = this.renderer.clock.setTimeout(this.flush, this.keymap.timeoutMs);
  };
  private release = (key: KeyEvent): void => {
    if (this.pending?.held.has(key.name)) {
      this.consume(key); this.pending.held.delete(key.name); this.pending.events.push(new KeyEvent(key)); return;
    }
    if (this.consumed.has(key.name)) { this.consume(key); this.consumed.delete(key.name); }
  };
  private focusChanged = (): void => {
    if (this.pending && this.pending.owner !== this.renderer.currentFocusedRenderable) this.flush();
  };
  // Paste first flushes any prefix, then goes through the ordinary paste path. Its text
  // is never interpreted as app bindings. Replay retains its original target and order.
  flush = (): void => {
    const pending = this.pending; this.clear();
    if (pending) this.forward(pending);
  };
  private forward(pending: Pending): void {
    const target = pending.owner;
    if (!target || target.isDestroyed) return;
    for (const key of pending.events) {
      if (target.isDestroyed) return;
      if (key.eventType === "release") {
        if (target instanceof EmbeddedTerminalRenderable) target.handleKeyPress(key);
      } else {
        target.onKeyDown?.(key);
        if (!key.defaultPrevented) target.handleKeyPress?.(key);
      }
    }
  }
  private clear(): void {
    if (this.timer !== undefined) this.renderer.clock.clearTimeout(this.timer);
    this.timer = undefined; this.pending = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.flush(); this.disposed = true;
    this.renderer.keyInput.off("keypress", this.press); this.renderer.keyInput.off("keyrelease", this.release);
    this.renderer.keyInput.off("paste", this.flush); this.renderer.off("focused_renderable", this.focusChanged);
    this.consumed.clear();
  }
}
