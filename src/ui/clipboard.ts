import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type ClipboardRepresentation,
  type ClipboardService,
  type CliRenderer,
} from "@opentui/core";
import { CancelledError, ClipboardError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export class Clipboard {
  private service: ClipboardService | undefined;
  private readonly abort = new AbortController();
  constructor(private readonly renderer: CliRenderer) {}
  async read(signal?: AbortSignal): Promise<Result<ClipboardRepresentation, ExpectedError>> {
    if (this.renderer.capabilities?.remote)
      return err(
        new ClipboardError(
          "Remote host clipboard reads are unavailable. Use terminal paste for text or file paths.",
        ),
      );
    this.service ??= createClipboard({
      host: createHostClipboard({ maxReadBytes: 16 * 1024 * 1024 }),
      terminal: createRendererClipboardAdapter(this.renderer),
    });
    // The SDK accepts MIME essence types only, without charset parameters.
    const result = await this.service.read({
      preferredTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "text/uri-list",
        "text/plain",
      ],
      signal: signal ? AbortSignal.any([this.abort.signal, signal]) : this.abort.signal,
    });
    if (result.status === "read") return ok(result.representation);
    if (result.status === "cancelled") return err(new CancelledError());
    return err(
      new ClipboardError(
        `Clipboard read ${result.status}. Use terminal paste for text or file paths.`,
        result.status === "failed" ? { cause: result.error } : undefined,
      ),
    );
  }
  async copy(text: string): Promise<Result<string, ExpectedError>> {
    this.service ??= createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(this.renderer),
    });
    const result = await this.service.writeText(text, {
      destination: "best-available",
      signal: this.abort.signal,
    });
    if (result.host.status === "written") return ok("Copied to clipboard");
    // OSC52 acknowledges local dispatch, not that the terminal actually changed its clipboard.
    if (result.terminal.status === "attempted")
      return ok("Clipboard request sent to terminal (OSC52)");
    if (result.host.status === "failed")
      return err(new ClipboardError("Clipboard write failed.", { cause: result.host.error }));
    return err(
      new ClipboardError(
        `Clipboard unavailable (host: ${result.host.status}; terminal: ${result.terminal.capability}).`,
      ),
    );
  }
  async dispose(): Promise<void> {
    this.abort.abort();
    await this.service?.dispose();
  }
}
