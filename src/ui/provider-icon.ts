import {
  ImageError, NativeImage, Renderable, TextAttributes, resolveImageRenderProtocol,
  type CliRenderer, type OptimizedBuffer,
} from "@opentui/core";
import { icons } from "../icons.ts";
import { err, ok, type Result } from "../result.ts";
import { uiTheme, type UiColors } from "./theme.ts";
import { providerIconMask, providerIconSize, type ProviderIconName } from "./provider-icon-data.ts";

const recoverable = new Set<ImageError["code"]>(["unsupported-feature", "unsupported-format", "unsupported-color-space", "memory-limit", "out-of-memory", "busy"]);
function imageOperation<T>(operation: () => T): Result<T, ImageError> {
  try { return ok(operation()); }
  catch (error) { if (error instanceof ImageError && recoverable.has(error.code)) return err(error); throw error; }
}

// A two-cell slot contains a 1.5x font-derived icon. OpenTUI owns graphics transport and placement.
export class ProviderIcon extends Renderable {
  private name: ProviderIconName | null = null;
  private glyph = "";
  private colors: UiColors;
  private image: NativeImage | null = null;
  private imageSignature = "";
  private failed = false;
  private resolutionKey = "";

  constructor(private readonly renderer: CliRenderer) {
    super(renderer, { id: "usage-provider-icon", position: "absolute", left: 0, top: 0, width: 2, height: 1, visible: false });
    this.selectable = false;
    this.colors = uiTheme(renderer).colors;
    uiTheme(renderer).bind(this, (colors) => { this.colors = colors; this.requestRender(); });
    renderer.on("capabilities", this.retryGraphics); renderer.on("resize", this.retryGraphics);
    renderer.on("frame", this.checkResolution);
  }

  setProvider(provider: string | null | undefined): boolean {
    const next = provider === "openai" || provider === "openai-codex" ? "openai" : provider === "anthropic" ? "claude" : null;
    if (next !== this.name) { this.name = next; this.failed = false; this.requestRender(); }
    this.glyph = next ? icons[next] : "";
    if (!next) this.visible = false;
    return next !== null;
  }

  private retryGraphics = (): void => { if (!this.isDestroyed) { this.failed = false; this.requestRender(); } };
  private checkResolution = (): void => {
    if (this.isDestroyed) return;
    const resolution = this.renderer.resolution;
    const key = `${resolution?.width}/${resolution?.height}/${this.renderer.terminalWidth}/${this.renderer.terminalHeight}`;
    // Pixel replies request a renderer frame but do not emit resize; invalidate this host-painted node once.
    if (key !== this.resolutionKey) { this.resolutionKey = key; this.requestRender(); }
  };

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.isDestroyed || !this.name || this.width < 2 || this.height < 1) return;
    const x = this.screenX, y = this.screenY;
    buffer.fillRect(x, y, 2, 1, this.colors.panel);
    const resolution = this.renderer.resolution;
    const protocol = resolveImageRenderProtocol("auto", this.renderer.capabilities, resolution !== null);
    if (!uiTheme(this.renderer).monochrome && !this.failed && resolution && (protocol === "kitty" || protocol === "sixel")) {
      const pixelWidth = Math.round(2 * resolution.width / this.renderer.terminalWidth);
      const pixelHeight = Math.round(resolution.height / this.renderer.terminalHeight);
      if (Number.isFinite(pixelWidth) && Number.isFinite(pixelHeight) && pixelWidth > 0 && pixelHeight >= pixelWidth * 0.75) {
        const image = this.getImage(Math.max(48, Math.min(256, Math.round(providerIconSize * pixelHeight / pixelWidth))));
        let failure: ImageError | undefined;
        if (image.ok) {
          const painted = imageOperation(() => buffer.drawImage(image.value, x, y, 2, 1, pixelWidth, pixelHeight, 0, 0, image.value.width, image.value.height, protocol));
          if (painted.ok && painted.value) return;
          if (!painted.ok) failure = painted.error;
        } else failure = image.error;
        this.failed = true;
        if (failure) console.warn(`[radian:provider-icon:${failure.code}] Graphics unavailable; using a font glyph.`);
      }
    }
    // Plain terminals retain an aligned, readable logo without unsupported escape sequences.
    buffer.drawText(this.glyph, x, y, this.colors.text, this.colors.panel, TextAttributes.BOLD);
  }

  private getImage(height: number): Result<NativeImage, ImageError> {
    const color = this.colors.text.toInts();
    const signature = `${this.name}/${height}/${color.join(",")}`;
    if (this.image && signature === this.imageSignature) return ok(this.image);
    const size = providerIconSize, mask = providerIconMask(this.name!);
    const pixels = new Uint8Array(size * height * 4), offset = Math.floor((height - size) / 2);
    for (let row = 0; row < size; row++) {
      const target = row + offset; if (target < 0 || target >= height) continue;
      for (let column = 0; column < size; column++) {
        const alpha = mask[row * size + column]!; if (!alpha) continue;
        const index = (target * size + column) * 4;
        pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2];
        pixels[index + 3] = Math.round(alpha * color[3] / 255);
      }
    }
    const created = imageOperation(() => NativeImage.fromRgba(pixels, size, height, size * 4, { owner: this.renderer.nativeScene.resourceContext }));
    if (!created.ok) return created;
    const previous = this.image;
    this.image = created.value; this.imageSignature = signature; previous?.dispose();
    return created;
  }

  protected override destroySelf(): void {
    this.renderer.off("capabilities", this.retryGraphics); this.renderer.off("resize", this.retryGraphics);
    this.renderer.off("frame", this.checkResolution);
    const image = this.image; this.image = null;
    this.runCleanup((run) => { run(() => image?.dispose()); run(() => super.destroySelf()); });
  }
}
