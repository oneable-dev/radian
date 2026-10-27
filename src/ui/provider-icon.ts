import {
  ImageError,
  NativeImage,
  OptimizedBuffer,
  RGBA,
  Renderable,
  resolveImageRenderProtocol,
  type CliRenderer,
} from "@opentui/core";
import { icons } from "../icons.ts";
import { err, ok, type Result } from "../result.ts";
import { uiTheme } from "./theme.ts";
import { styleBackground, type UiStyle } from "./theme-styles.ts";
import { providerIconMask, providerIconSize, type ProviderIconName } from "./provider-icon-data.ts";

const decoder = new TextDecoder();
const recoverable = new Set<ImageError["code"]>([
  "unsupported-feature",
  "unsupported-format",
  "unsupported-color-space",
  "memory-limit",
  "out-of-memory",
  "busy",
]);
function imageOperation<T>(operation: () => T): Result<T, ImageError> {
  try {
    return ok(operation());
  } catch (error) {
    if (error instanceof ImageError && recoverable.has(error.code)) return err(error);
    throw error;
  }
}

// A two-cell slot contains a 1.5x font-derived icon. OpenTUI owns graphics transport and placement.
export class ProviderIcon extends Renderable {
  private name: ProviderIconName | null = null;
  private glyph = "";
  private style: UiStyle;
  private image: NativeImage | null = null;
  private imageSignature = "";
  private failed = false;

  constructor(private readonly renderer: CliRenderer) {
    super(renderer, {
      id: "usage-provider-icon",
      position: "absolute",
      left: 0,
      top: 0,
      width: 2,
      height: 1,
      visible: false,
    });
    this.selectable = false;
    this.style = uiTheme(renderer).styles["branding.provider"];
    uiTheme(renderer).bindStyles(this, (styles) => {
      this.style = styles["branding.provider"];
      this.requestRender();
    });
    renderer.on("capabilities", this.retryGraphics);
    renderer.on("resize", this.retryGraphics);
    renderer.addPostProcessFn(this.paintImage);
  }

  setProvider(provider: string | null | undefined): boolean {
    const next =
      provider === "openai" || provider === "openai-codex"
        ? "openai"
        : provider === "anthropic"
          ? "claude"
          : null;
    if (next !== this.name) {
      this.name = next;
      this.failed = false;
      this.requestRender();
    }
    this.glyph = next ? icons[next] : "";
    if (!next) this.visible = false;
    return next !== null;
  }

  private retryGraphics = (): void => {
    if (!this.isDestroyed) {
      this.failed = false;
      this.requestRender();
    }
  };

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.isDestroyed || !this.name || this.width < 2 || this.height < 1) return;
    // The glyph is both the ordinary-terminal fallback and a visibility/color probe. Native
    // composition dims it through translucent backdrops and removes it under opaque popups.
    buffer.fillRect(this.screenX, this.screenY, 2, 1, styleBackground(this.style));
    buffer.drawText(
      this.glyph,
      this.screenX,
      this.screenY,
      this.style.fg,
      styleBackground(this.style),
      this.style.attributes,
    );
  }

  private paintImage = (buffer: OptimizedBuffer): void => {
    if (
      this.isDestroyed ||
      this.renderer.isDestroyed ||
      !this.name ||
      this.failed ||
      uiTheme(this.renderer).monochrome ||
      this.width < 2 ||
      this.height < 1
    )
      return;
    // oxlint-disable-next-line typescript/no-this-alias -- Walk this renderable's ancestry without changing the callback receiver.
    for (let node: Renderable | null = this; node; node = node.parent) if (!node.visible) return;
    const resolution = this.renderer.resolution;
    const protocol = resolveImageRenderProtocol(
      "auto",
      this.renderer.capabilities,
      resolution !== null,
    );
    if (!resolution || (protocol !== "kitty" && protocol !== "sixel")) return;
    const pixelWidth = Math.round((2 * resolution.width) / this.renderer.terminalWidth);
    const pixelHeight = Math.round(resolution.height / this.renderer.terminalHeight);
    if (
      !Number.isFinite(pixelWidth) ||
      !Number.isFinite(pixelHeight) ||
      pixelWidth <= 0 ||
      pixelHeight < pixelWidth * 0.75
    )
      return;
    const x = this.screenX,
      y = this.screenY;
    if (x < 0 || y < 0 || x + 2 > buffer.width || y >= buffer.height) return;

    // Resolve text with the checked API: native cell graphemes are opaque pooled IDs, not
    // Unicode codepoints. Never paint an image over a popup that has replaced the logo.
    const line = decoder.decode(buffer.getRealCharBytes(true)).split("\n")[y] ?? "";
    let match = line.indexOf(this.glyph);
    while (match >= 0 && Bun.stringWidth(line.slice(0, match)) < x)
      match = line.indexOf(this.glyph, match + this.glyph.length);
    if (match < 0 || Bun.stringWidth(line.slice(0, match)) !== x) return;
    const colors = buffer.withBuffers(({ char, fg, bg, width }) => {
      const cell = y * width + x,
        offset = cell * 4;
      if (char[cell + 1] !== 32) return undefined;
      // Own the copied colors before ending the native lease or mutating the frame.
      const foreground = RGBA.fromArray(fg.slice(offset, offset + 4)),
        background = RGBA.fromArray(bg.slice(offset, offset + 4));
      if (!background.equals(RGBA.fromArray(bg.slice(offset + 4, offset + 8)))) return undefined;
      return { foreground, background };
    });
    if (!colors) return;

    const image = this.getImage(
      Math.max(48, Math.min(256, Math.round((providerIconSize * pixelHeight) / pixelWidth))),
      colors.foreground,
      colors.background,
    );
    let failure: ImageError | undefined;
    if (image.ok) {
      // Paint AFTER popup composition with the resulting colors already baked in. The opaque
      // image keeps exactly the same geometry and cannot turn into a black alpha-overlay slot.
      buffer.fillRect(x, y, 2, 1, colors.background);
      const painted = imageOperation(() =>
        buffer.drawImage(
          image.value,
          x,
          y,
          2,
          1,
          pixelWidth,
          pixelHeight,
          0,
          0,
          image.value.width,
          image.value.height,
          protocol,
        ),
      );
      if (painted.ok && painted.value) return;
      buffer.drawText(
        this.glyph,
        x,
        y,
        colors.foreground,
        colors.background,
        this.style.attributes,
      );
      if (!painted.ok) failure = painted.error;
    } else failure = image.error;
    this.failed = true;
    if (failure)
      console.warn(
        `[radian:provider-icon:${failure.code}] Graphics unavailable; using a font glyph.`,
      );
  };

  private getImage(
    height: number,
    foreground: RGBA,
    background: RGBA,
  ): Result<NativeImage, ImageError> {
    const color = foreground.toInts(),
      fill = background.toInts();
    const signature = `${this.name}/${height}/${color.join(",")}/${fill.join(",")}`;
    if (this.image && signature === this.imageSignature) return ok(this.image);
    const size = providerIconSize,
      mask = providerIconMask(this.name!);
    const pixels = new Uint8Array(size * height * 4),
      offset = Math.floor((height - size) / 2);
    for (let row = 0; row < height; row++) {
      const source = row - offset;
      for (let column = 0; column < size; column++) {
        const alpha =
          source >= 0 && source < size
            ? ((mask[source * size + column]! / 255) * color[3]) / 255
            : 0;
        const index = (row * size + column) * 4;
        pixels[index] = Math.round(fill[0] + (color[0] - fill[0]) * alpha);
        pixels[index + 1] = Math.round(fill[1] + (color[1] - fill[1]) * alpha);
        pixels[index + 2] = Math.round(fill[2] + (color[2] - fill[2]) * alpha);
        pixels[index + 3] = 255;
      }
    }
    const created = imageOperation(() =>
      NativeImage.fromRgba(pixels, size, height, size * 4, {
        owner: this.renderer.nativeScene.resourceContext,
      }),
    );
    if (!created.ok) return created;
    const previous = this.image;
    this.image = created.value;
    this.imageSignature = signature;
    previous?.dispose();
    return created;
  }

  protected override destroySelf(): void {
    this.renderer.off("capabilities", this.retryGraphics);
    this.renderer.off("resize", this.retryGraphics);
    this.renderer.removePostProcessFn(this.paintImage);
    const image = this.image;
    this.image = null;
    this.runCleanup((run) => {
      run(() => image?.dispose());
      run(() => super.destroySelf());
    });
  }
}
