import {
  BoxRenderable,
  ImageError,
  ImageRenderable,
  NativeImage,
  TextRenderable,
  resolveImageRenderProtocol,
  type CliRenderer,
} from "@opentui/core";
import { reportUnexpected } from "../errors.ts";
import { uiTheme } from "./theme.ts";
import { paintText, type UiStyle } from "./theme-styles.ts";
import { stateIconMask, stateIconSize } from "./state-icon-data.ts";

const recoverable = new Set<ImageError["code"]>([
  "unsupported-feature",
  "unsupported-format",
  "unsupported-color-space",
  "memory-limit",
  "out-of-memory",
  "busy",
]);
const dots = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128],
] as const;

// Rasterize the original glyph into 2x4-dot cells, preserving its outline on plain
// and monochrome terminals without reducing it to one colored pixel per cell.
function dotArtwork(mask: Uint8Array, rows: number): string {
  const columns = rows * 2,
    lines: string[] = [],
    size = stateIconSize;
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let column = 0; column < columns; column++) {
      let bits = 0;
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 2; x++) {
          const left = Math.floor(((column * 2 + x) * size) / (columns * 2)),
            right = Math.floor(((column * 2 + x + 1) * size) / (columns * 2));
          const top = Math.floor(((row * 4 + y) * size) / (rows * 4)),
            bottom = Math.floor(((row * 4 + y + 1) * size) / (rows * 4));
          let alpha = 0;
          for (let sy = top; sy < bottom; sy++)
            for (let sx = left; sx < right; sx++) alpha += mask[sy * size + sx]!;
          if (alpha >= 80 * (right - left) * (bottom - top)) bits |= dots[y]![x]!;
        }
      line += bits ? String.fromCodePoint(0x2800 + bits) : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// Compact, plain-terminal and graphics forms all come from the same font glyph.
export class StateIcon extends BoxRenderable {
  private readonly glyph: TextRenderable;
  private readonly raster: TextRenderable;
  private readonly image: ImageRenderable;
  private text = "";
  private rows = 1;
  private signature = "";
  private rasterSignature = "";
  private failed = false;
  private style: UiStyle;

  constructor(
    private readonly renderer: CliRenderer,
    id: string,
  ) {
    super(renderer, {
      id,
      width: 1,
      height: 1,
      flexShrink: 0,
      justifyContent: "center",
      alignItems: "center",
      overflow: "hidden",
      renderBefore: () => this.paintImage(),
    });
    this.style = uiTheme(renderer).styles["ui.muted"];
    this.glyph = new TextRenderable(renderer, {
      id: `${id}:glyph`,
      height: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.raster = new TextRenderable(renderer, {
      id: `${id}:raster`,
      width: 1,
      height: 1,
      wrapMode: "none",
      selectable: false,
      visible: false,
    });
    this.image = new ImageRenderable(renderer, {
      id: `${id}:image`,
      width: "100%",
      height: "100%",
      fit: "fit",
      visible: false,
      onError: (error) => {
        if (error instanceof ImageError && recoverable.has(error.code)) this.fallback(error);
        else {
          reportUnexpected(error, "state icon");
          this.failed = true;
          this.fallback();
        }
      },
    });
    this.add(this.glyph);
    this.add(this.raster);
    this.add(this.image);
    uiTheme(renderer).bindStyles(this, (styles) => {
      this.style = styles["ui.muted"];
      paintText(this.glyph, this.style);
      paintText(this.raster, this.style);
      this.paintImage();
    });
  }

  update(glyph: string, rows: number): number {
    const mask = rows > 1 ? stateIconMask(glyph) : undefined;
    this.text = glyph;
    this.rows = mask ? rows : 1;
    this.width = mask ? rows * 2 : Math.max(1, Bun.stringWidth(glyph));
    this.height = this.rows;
    this.glyph.content = glyph;
    this.glyph.visible = !mask;
    this.image.visible = false;
    this.raster.visible = false;
    if (mask && this.rasterSignature !== `${glyph}/${rows}`) {
      this.rasterSignature = `${glyph}/${rows}`;
      this.raster.width = rows * 2;
      this.raster.height = rows;
      this.raster.content = dotArtwork(mask, rows);
    }
    this.paintImage();
    return this.rows;
  }

  private paintImage(): void {
    if (this.isDestroyed || !this.image || this.rows <= 1) return;
    const mask = stateIconMask(this.text);
    if (!mask) return;
    const theme = uiTheme(this.renderer);
    const protocol = resolveImageRenderProtocol(
      "auto",
      this.renderer.capabilities,
      this.renderer.resolution !== null,
    );
    if (theme.monochrome || (protocol !== "kitty" && protocol !== "sixel")) {
      this.fallback();
      return;
    }
    const color = this.style.fg.toInts(),
      fill = (theme.styles["ui.text"].bg ?? theme.colors.panel).toInts();
    const signature = `${this.text}/${color.join(",")}/${fill.join(",")}`;
    if (signature === this.signature) {
      this.image.visible = !this.failed;
      this.raster.visible = this.failed;
      return;
    }
    this.signature = signature;
    this.failed = false;
    this.image.visible = true;
    this.raster.visible = false;
    this.glyph.visible = false;
    const pixels = new Uint8Array(stateIconSize ** 2 * 4);
    for (let index = 0; index < mask.length; index++) {
      const alpha = ((mask[index]! / 255) * color[3]) / 255;
      for (let channel = 0; channel < 3; channel++)
        pixels[index * 4 + channel] = Math.round(
          fill[channel]! + (color[channel]! - fill[channel]!) * alpha,
        );
      pixels[index * 4 + 3] = 255;
    }
    let image: NativeImage;
    try {
      image = NativeImage.fromRgba(pixels, stateIconSize, stateIconSize, stateIconSize * 4, {
        owner: this.renderer.nativeScene!.resourceContext,
      });
    } catch (error) {
      if (error instanceof ImageError && recoverable.has(error.code)) {
        this.failed = true;
        this.fallback(error);
        return;
      }
      throw error;
    }
    this.image.source = image;
    image.dispose();
  }

  private fallback(error?: ImageError): void {
    if (this.isDestroyed) return;
    if (error) this.failed = true;
    this.image.visible = false;
    this.raster.visible = true;
    this.glyph.visible = false;
    if (error)
      console.warn(
        `[radian:state-icon:${error.code}] Image unavailable; using the font-derived dot raster.`,
      );
  }
}
