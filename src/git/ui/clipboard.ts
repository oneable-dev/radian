import { createClipboard, createHostClipboard, createRendererClipboardAdapter, type ClipboardService, type CliRenderer } from "@opentui/core";
import { ClipboardError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";

export class GitClipboard {
  private service: ClipboardService | undefined;
  private readonly abort = new AbortController();
  constructor(private readonly renderer: CliRenderer) {}
  async copy(text: string): Promise<Result<string, ExpectedError>> {
    this.service ??= createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(this.renderer) });
    const result = await this.service.writeText(text, { destination: "best-available", signal: this.abort.signal });
    if (result.host.status === "written") return ok("Copied to clipboard");
    // OSC52 acknowledges local dispatch, not that the terminal actually changed its clipboard.
    if (result.terminal.status === "attempted") return ok("Clipboard request sent to terminal (OSC52)");
    if (result.host.status === "failed") return err(new ClipboardError("Clipboard write failed.", { cause: result.host.error }));
    return err(new ClipboardError(`Clipboard unavailable (host: ${result.host.status}; terminal: ${result.terminal.capability}).`));
  }
  async dispose(): Promise<void> { this.abort.abort(); await this.service?.dispose(); }
}
