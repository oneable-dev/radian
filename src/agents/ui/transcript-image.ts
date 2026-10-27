import {
  BoxRenderable,
  ImageError,
  ImageRenderable,
  RenderableEvents,
  TextRenderable,
  resolveImageRenderProtocol,
  type CliRenderer,
} from "@opentui/core";
import {
  maximumPreviewImageBytes,
  type TranscriptImage,
  type TranscriptImageProvider,
} from "../transcript-images.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { reportUnexpected } from "../../errors.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";

const expectedImageErrors = new Set<ImageError["code"]>([
  "unsupported-format",
  "unsupported-color-space",
  "malformed-data",
  "dimension-limit",
  "memory-limit",
  "out-of-memory",
  "unsupported-feature",
  "busy",
]);

// Exists only while its section is expanded. Collapse releases requests, encoded bytes and native pixels.
export class TranscriptImagePreview {
  readonly root: BoxRenderable;
  private readonly message: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private image: ImageRenderable | undefined;
  private abort: AbortController | undefined;
  private identity = "";
  private disposed = false;

  constructor(
    private readonly renderer: CliRenderer,
    id: string,
    private readonly provider: TranscriptImageProvider | undefined,
    private readonly changing: () => void,
    private readonly availableRows: () => number,
  ) {
    this.root = new BoxRenderable(renderer, {
      id,
      width: "100%",
      flexShrink: 0,
      minHeight: 1,
      flexDirection: "column",
      onSizeChange: () => this.reflow(),
    });
    this.message = new TextRenderable(renderer, {
      id: `${id}:message`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      selectable: false,
      wrapMode: "none",
    });
    this.spinner = new LoadingSpinner(renderer, { id: `${id}:loading` });
    this.spinner.root.position = "absolute";
    this.spinner.root.top = 0;
    this.spinner.root.left = 0;
    this.spinner.root.zIndex = 1;
    this.root.add(this.message);
    this.root.add(this.spinner.root);
    uiTheme(renderer).bindStyles(this.root, (styles) => {
      paintText(this.message, styles["ui.muted"]);
      paintText(this.spinner.root, styles["status.working"]);
    });
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  get retaining(): boolean {
    return this.abort !== undefined;
  }

  update(sessionId: string | null, descriptor: TranscriptImage, allowed = true): void {
    if (this.disposed || this.root.isDestroyed) return;
    const protocol = resolveImageRenderProtocol(
      "auto",
      this.renderer.capabilities,
      this.renderer.resolution !== null,
    );
    const identity = JSON.stringify([sessionId, descriptor.id, protocol, allowed]);
    if (identity === this.identity) {
      this.reflow();
      return;
    }
    this.cancel();
    this.identity = identity;
    if (!allowed) {
      this.show("Preview memory limit reached; collapse another image.");
      return;
    }
    if (protocol !== "kitty" && protocol !== "sixel") {
      this.show("Image preview needs a terminal with Kitty or Sixel graphics.");
      return;
    }
    if (!sessionId || !this.provider) {
      this.show("Open this session with an updated runtime to preview its image.");
      return;
    }
    const abort = (this.abort = new AbortController());
    this.show("Loading image…");
    this.spinner.start();
    void this.load(sessionId, descriptor, abort).catch((error: unknown) => {
      const message = reportUnexpected(error, "image preview");
      if (this.current(abort)) {
        this.spinner.stop();
        this.show(message);
      }
    });
  }
  private current(abort: AbortController): boolean {
    return (
      !this.disposed && !this.root.isDestroyed && this.abort === abort && !abort.signal.aborted
    );
  }
  private async load(
    sessionId: string,
    descriptor: TranscriptImage,
    abort: AbortController,
  ): Promise<void> {
    const result = await this.provider!(sessionId, descriptor.id, abort.signal);
    if (!this.current(abort)) return;
    if (!result.ok) {
      this.spinner.stop();
      this.show(`[${result.error.code}] ${result.error.message}`);
      return;
    }
    if (
      !result.value.byteLength ||
      result.value.byteLength > maximumPreviewImageBytes ||
      result.value.byteLength !== descriptor.byteLength
    ) {
      this.spinner.stop();
      this.show("[PROTOCOL_ERROR] Image preview bytes do not match the attachment descriptor.");
      return;
    }
    this.changing();
    const image = new ImageRenderable(this.renderer, {
      id: `${this.root.id}:image`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      fit: "fit",
      protocol: "auto",
      onLoad: () => {
        if (!this.current(abort)) return;
        this.changing();
        this.message.visible = false;
        this.spinner.stop();
        this.reflow();
        this.renderer.requestRender();
      },
      onError: (error) => {
        if (!this.current(abort)) return;
        const message =
          error instanceof ImageError && expectedImageErrors.has(error.code)
            ? `[${error.code}] Image preview could not be decoded.`
            : reportUnexpected(error, "image decode");
        this.changing();
        image.visible = false;
        this.spinner.stop();
        this.show(message);
      },
    });
    this.image = image;
    this.root.add(image);
    image.source = result.value;
    await image.loadPromise;
  }
  private show(text: string): void {
    this.changing();
    this.message.content = `  ${text}`;
    this.message.visible = true;
    this.renderer.requestRender();
  }
  private reflow(): void {
    const image = this.image;
    if (!image?.image || image.isDestroyed || this.disposed) return;
    const aspect = (image.image.width / image.image.height) * image.cellAspectRatio;
    const rows = Math.max(
      1,
      Math.min(this.availableRows(), Math.ceil(Math.max(1, this.root.width) / aspect)),
    );
    if (image.height !== rows) {
      this.changing();
      image.height = rows;
    }
  }
  private cancel(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.spinner.cancel();
    const image = this.image;
    this.image = undefined;
    if (image && !image.isDestroyed) {
      image.source = undefined;
      image.destroyRecursively();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }
}
