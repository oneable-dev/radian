import type { CliRenderer, TerminalColors } from "@opentui/core";

// Theme belongs to the attached TUI, not the detached runtime: two terminals may
// connect to the same processes with different palettes. Only the embedded VT is
// configured; these OSC sequences are never sent to the outer terminal or shell.
export class TerminalTheme {
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private value = "";

  constructor(
    private readonly renderer: CliRenderer,
    colors: TerminalColors,
  ) {
    this.update(colors);
    renderer.on("palette", this.update);
    renderer.once("destroy", this.dispose);
  }
  get ansi(): string {
    return this.value;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private update = (colors: TerminalColors): void => {
    let ansi = "";
    const color = (command: string, value: string | null | undefined) => {
      if (value && /^#[\da-f]{6}$/i.test(value)) ansi += `\x1b]${command};${value}\x07`;
    };
    color("10", colors.defaultForeground);
    color("11", colors.defaultBackground);
    color("12", colors.cursorColor);
    colors.palette.slice(0, 256).forEach((value, index) => color(`4;${index}`, value));
    if (ansi === this.value) return;
    this.value = ansi;
    for (const listener of this.listeners) listener();
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.off("palette", this.update);
    this.renderer.off("destroy", this.dispose);
    this.listeners.clear();
  };
}
