import { Terminal as Screen } from "@xterm/headless";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ResourceError, systemCode } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  KeybindingsManager,
  getKeybindings,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { terminalScreen } from "../runtime/pty/screen.ts";

export type ExtensionComponentFrame = {
  cols: number;
  rows: number;
  revision: number;
  ansi: string;
};

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];
type OwnedComponent = Component & { dispose?(): void };
type Bindings = ReturnType<KeybindingsManager["getUserBindings"]>;

function readBindings(path: string | undefined): Result<Bindings, ResourceError> {
  if (!path) return ok({});
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.values(value).every(
        (entry) =>
          typeof entry === "string" ||
          (Array.isArray(entry) && entry.every((key) => typeof key === "string")),
      )
    ) {
      return err(new ResourceError(`Invalid extension keybindings at ${path}.`));
    }
    return ok(value as Bindings);
  } catch (cause) {
    if (systemCode(cause) === "ENOENT") return ok({});
    if (systemCode(cause) || cause instanceof SyntaxError) {
      return err(new ResourceError(`Cannot load extension keybindings at ${path}.`, { cause }));
    }
    throw cause;
  }
}

class ComponentKeys extends KeybindingsManager {
  constructor(private readonly path: string | undefined) {
    super(TUI_KEYBINDINGS);
    this.reload();
  }
  reload(): void {
    const result = readBindings(this.path);
    if (!result.ok) throw result.error;
    this.setUserBindings(result.value);
  }
  getEffectiveConfig(): Bindings {
    return this.getResolvedBindings();
  }
}

/** A real Pi viewport renderer whose terminal is an isolated VT, never process stdin/stdout. */
class ComponentTerminal implements Terminal {
  columns = 80;
  rows = 24;
  readonly kittyProtocolActive = false;
  readonly screen = new Screen({
    cols: this.columns,
    rows: this.rows,
    scrollback: 0,
    allowProposedApi: true,
  });
  private input: ((data: string) => void) | undefined;
  private resized: (() => void) | undefined;
  private disposed = false;
  private cursorVisible = true;
  private revision = 0;
  private cached: ExtensionComponentFrame | undefined;

  constructor(private readonly changed: () => void) {
    this.screen.onData((data) => this.input?.(data));
    this.screen.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(25)) this.cursorVisible = true;
      return false;
    });
    this.screen.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(25)) this.cursorVisible = false;
      return false;
    });
  }

  start(input: (data: string) => void, resized: () => void): void {
    this.input = input;
    this.resized = resized;
    this.write("\u001b[?2004h");
  }

  stop(): void {
    this.input = undefined;
    this.resized = undefined;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    if (this.disposed) return;
    this.screen.write(data, () => {
      if (this.disposed) return;
      this.revision++;
      this.cached = undefined;
      this.changed();
    });
  }

  send(data: string): void {
    this.input?.(data);
  }

  resize(columns: number, rows: number): void {
    if (columns === this.columns && rows === this.rows) return;
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.cached = undefined;
    this.revision++;
    this.resized?.();
  }

  get frame(): ExtensionComponentFrame {
    return (this.cached ??= {
      cols: this.columns,
      rows: this.rows,
      revision: this.revision,
      // Only the parsed screen's cells and cursor are transported. OSC clipboard,
      // titles, device queries and arbitrary terminal controls never reach the app.
      ansi: terminalScreen(this.screen) + `\x1b[?25${this.cursorVisible ? "h" : "l"}`,
    });
  }

  moveBy(lines: number): void {
    if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
  }
  hideCursor(): void {
    this.write("\x1b[?25l");
  }
  showCursor(): void {
    this.write("\x1b[?25h");
  }
  clearLine(): void {
    this.write("\x1b[2K");
  }
  clearFromCursor(): void {
    this.write("\x1b[J");
  }
  clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }
  // These decorations belong to the actual host, not an extension's virtual terminal.
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.screen.dispose();
  }
}

export class ExtensionComponent {
  private readonly terminal: ComponentTerminal;
  private readonly tui: TuiAltScreen;
  private component: OwnedComponent | undefined;
  private keys: ComponentKeys | undefined;
  private completed = false;
  private cancelled = false;
  private disposed = false;
  private hidden = false;
  private focused = true;

  constructor(
    private readonly theme: ExtensionUIContext["theme"],
    private readonly changed: () => void,
    private readonly finish: (value: unknown) => void,
    private readonly agentDir?: string,
  ) {
    this.terminal = new ComponentTerminal(changed);
    this.tui = new TuiAltScreen(this.terminal, true);
  }

  get frame(): ExtensionComponentFrame {
    return this.terminal.frame;
  }
  get visible(): boolean {
    return !this.hidden && !this.completed && !this.disposed;
  }

  async initialize(factory: CustomFactory, options?: CustomOptions): Promise<void> {
    const keys = new ComponentKeys(
      this.agentDir ? join(this.agentDir, "keybindings.json") : undefined,
    );
    this.keys = keys;
    // The SDK exports its nominal manager type but not its constructor. Components
    // receive the same public navigation API; app-owned bindings stay in Radian.
    const component = await this.withKeys(() =>
      factory(this.tui, this.theme, keys as unknown as Parameters<CustomFactory>[2], this.done),
    );
    if (this.disposed || this.completed) {
      // A factory can complete synchronously, or resolve after the owning session closes.
      if (this.cancelled) component.handleInput?.("\x03");
      component.dispose?.();
      return;
    }
    this.component = component;
    this.tui.addChild(component);
    this.tui.setFocus(component);
    // The Radian popup supplies the outer placement. Its content owns a complete
    // isolated viewport; the real TUI still provides nested overlays and focus.
    options?.onHandle?.({
      hide: () => this.setHidden(true),
      setHidden: (hidden) => this.setHidden(hidden),
      isHidden: () => this.hidden,
      focus: () => {
        this.focused = true;
        this.setHidden(false);
        this.tui.setFocus(component);
      },
      unfocus: () => {
        this.focused = false;
        this.tui.setFocus(null);
      },
      isFocused: () => this.focused && !this.hidden,
      getBounds: () => ({
        row: 0,
        col: 0,
        width: this.terminal.columns,
        height: this.terminal.rows,
      }),
    });
    this.tui.start();
    this.tui.renderNow(true);
    this.changed();
  }

  private setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.changed();
  }

  private done = (value: unknown): void => {
    if (this.completed) return;
    this.completed = true;
    this.finish(value);
    this.dispose();
  };

  input(data: string): void {
    if (!this.visible || this.disposed) return;
    if (!this.component && (data === "\u0003" || data === "\u001b")) {
      this.cancel();
      return;
    }
    this.withKeys(() => this.terminal.send(data));
  }

  private withKeys<T>(action: () => T): T {
    if (!this.keys) return action();
    const previous = getKeybindings();
    setKeybindings(this.keys);
    try {
      return action();
    } finally {
      setKeybindings(previous);
    }
  }

  resize(columns: number, rows: number): void {
    if (this.disposed) return;
    this.terminal.resize(columns, rows);
    this.tui.renderNow(true);
  }

  cancel(): void {
    if (this.completed) return;
    // Supported package panels explicitly treat Ctrl+C as discard/cancel. Let their
    // callbacks settle outer command promises; resolving custom() alone is insufficient.
    this.cancelled = true;
    try {
      this.withKeys(() => this.component?.handleInput?.("\x03"));
    } finally {
      this.done(undefined);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tui.stop();
    this.component?.dispose?.();
    this.component = undefined;
    this.terminal.dispose();
  }
}
