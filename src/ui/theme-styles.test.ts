import { expect, test } from "bun:test";
import {
  InputRenderable,
  TextRenderable,
  TextAttributes,
  type TerminalColors,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { expectError, expectOk } from "../testing/results.ts";
import { parseTheme } from "./theme-config.ts";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";

const rgb = (color: { toInts(): number[] }) => color.toInts().slice(0, 3);
const defaultPalette = (): TerminalColors => ({
  palette: [],
  defaultForeground: null,
  defaultBackground: null,
  cursorColor: null,
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightForeground: null,
  highlightBackground: null,
});

test("Legacy colors and role styles coexist while preserving cleared backgrounds and false attributes", () => {
  // Add detailed styles without migrating existing config files.
  const input = {
    success: "#123456",
    styles: {
      "syntax.string": { fg: "#ABCDEF", bg: null, bold: false, italic: true, underline: false },
    },
  };

  const result = expectOk(parseTheme(input));

  // Treating false/null as missing would prevent clearing inherited emphasis/backgrounds.
  expect(result).toEqual(input);
  expect(expectOk(parseTheme({ success: "#123456" }))).toEqual({ success: "#123456" });
});

test.each([
  { styles: null },
  { styles: [] },
  { styles: { unknown: {} } },
  { styles: { "syntax.string": "green" } },
  { styles: { "syntax.string": { fg: null } } },
  { styles: { "syntax.string": { fg: "green" } } },
  { styles: { "syntax.string": { bg: "#123" } } },
  { styles: { "syntax.string": { bold: "false" } } },
  { styles: { "syntax.string": { underline: 1 } } },
  { styles: { "syntax.string": { link: "status.success" } } },
])("Unknown styles, attributes, and invalid values return input errors: %j", (input) => {
  // Reject typos and ambiguous links rather than silently ignoring them.
  const result = parseTheme(input);

  expect(expectError(result).code).toBe("INVALID_INPUT");
});

test("Success-only overrides leave strings, additions, and Git graph greens unchanged", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    // Equal default colors must not imply dependencies between groups.
    const theme = uiTheme(app.renderer);
    const before = theme.styles;

    theme.configure(defaultPalette(), {
      styles: { "status.success": { fg: "#AA00FF", bold: true } },
    });

    expect(rgb(theme.styles["status.success"].fg)).toEqual([170, 0, 255]);
    for (const group of ["syntax.string", "git.added", "diff.added", "git.graph.1"] as const) {
      expect(theme.styles[group].fg.equals(before[group].fg)).toBe(true);
    }

    expect(theme.styles["syntax.string"].fg.intent).toBe("indexed");
    expect(theme.styles["syntax.string"].fg.slot).toBe(2);
    expect(theme.styles["ui.text"].fg.intent).toBe("default");
  } finally {
    await app.dispose();
  }
});

test("Shared legacy colors remain defaults and specific style overrides apply last", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);
    theme.configure(defaultPalette(), {
      success: "#112233",
      styles: { "syntax.string": { fg: "#445566" } },
    });

    // Legacy success sets shared defaults; new styles affect only their own roles.
    expect(rgb(theme.styles["status.success"].fg)).toEqual([17, 34, 51]);
    expect(rgb(theme.styles["git.graph.1"].fg)).toEqual([17, 34, 51]);
    expect(rgb(theme.styles["syntax.string"].fg)).toEqual([68, 85, 102]);
  } finally {
    await app.dispose();
  }
});

test("Attribute-only changes refresh screens and false removes emphasis despite unchanged colors", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);
    const node = new TextRenderable(app.renderer, { content: "STYLE_PROBE", height: 1 });

    app.renderer.root.add(node);

    let paints = 0;
    theme.bindStyles(node, (styles) => {
      paintText(node, styles["footer.key"]);
      paints++;
    });

    const palette = defaultPalette();
    const before = theme.styles["footer.key"].fg;

    // Same-palette attribute updates must still trigger rerendering.
    theme.configure(palette, {
      styles: { "footer.key": { bold: true, italic: true, underline: true, bg: "#223344" } },
    });
    await app.renderOnce();
    await app.renderOnce();

    let span = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("STYLE_PROBE"))!;
    expect(span.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(span.attributes & TextAttributes.ITALIC).not.toBe(0);
    expect(span.attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(rgb(span.bg)).toEqual([34, 51, 68]);
    expect(theme.styles["footer.key"].fg.equals(before)).toBe(true);

    theme.configure(palette, {
      styles: { "footer.key": { bold: false, italic: false, underline: false, bg: null } },
    });
    await app.renderOnce();
    await app.renderOnce();
    span = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("STYLE_PROBE"))!;
    expect(
      span.attributes & (TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.UNDERLINE),
    ).toBe(0);
    expect(theme.styles["footer.key"].bg).toBeUndefined();
    expect(rgb(span.bg)).not.toEqual([34, 51, 68]);

    const count = paints;
    node.destroyRecursively();
    theme.configure(palette, { styles: { "footer.key": { bold: true } } });
    expect(paints).toBe(count);
  } finally {
    await app.dispose();
  }
});

test("Input focus applies dedicated style emphasis without leaving previous attributes", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);
    const input = new InputRenderable(app.renderer, { value: "FOCUS_STYLE", width: 20 });

    app.renderer.root.add(input);
    theme.input(input);
    theme.configure(defaultPalette(), {
      styles: { "ui.input": { italic: true }, "ui.inputFocused": { bold: true, underline: true } },
    });

    // Components determine focus; styles determine presentation.
    input.focus();
    await app.renderOnce();
    await app.renderOnce();
    expect(input.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(input.attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(input.attributes & TextAttributes.ITALIC).toBe(0);
    input.blur();
    await app.renderOnce();
    await app.renderOnce();
    expect(input.attributes & TextAttributes.ITALIC).not.toBe(0);
    expect(input.attributes & (TextAttributes.BOLD | TextAttributes.UNDERLINE)).toBe(0);
    expect(input.value).toBe("FOCUS_STYLE");
  } finally {
    await app.dispose();
  }
});

test("Popup surfaces follow the normal background and do not dim surrounding content by default", async () => {
  // A normal-surface override must not leave floating windows using the terminal's older background.
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);

    theme.configure(defaultPalette(), { styles: { "ui.text": { bg: "#182028" } } });

    // Body and border fills use Normal, while the modal backdrop adds no separate shade.
    expect(rgb(theme.styles["ui.popup"].bg!)).toEqual([24, 32, 40]);
    expect(theme.styles["ui.backdrop"].bg!.a).toBe(0);
    theme.configure(defaultPalette(), { styles: { "ui.text": { bg: null } } });
    expect(theme.styles["ui.popup"].bg!.equals(theme.colors.panel)).toBe(true);
  } finally {
    await app.dispose();
  }
});

test("Explicit popup and backdrop backgrounds retain precedence over the normal surface", async () => {
  // Existing theme choices remain authoritative, including an explicitly cleared popup background.
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);

    theme.configure(defaultPalette(), {
      styles: {
        "ui.text": { bg: "#182028" },
        "ui.popup": { bg: "#445566" },
        "ui.backdrop": { bg: "#112233" },
      },
    });

    expect(rgb(theme.styles["ui.popup"].bg!)).toEqual([68, 85, 102]);
    expect(rgb(theme.styles["ui.backdrop"].bg!)).toEqual([17, 34, 51]);
    theme.configure(defaultPalette(), {
      styles: { "ui.text": { bg: "#182028" }, "ui.popup": { bg: null } },
    });
    expect(theme.styles["ui.popup"].bg).toBeUndefined();
  } finally {
    await app.dispose();
  }
});

test("Shared heading styles supply level defaults while individual overrides remain independent", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);
    theme.configure(defaultPalette(), {
      styles: {
        "markup.heading": { fg: "#112233", bold: false },
        "markup.heading.2": { fg: "#445566" },
      },
    });

    expect(rgb(theme.styles["markup.heading.1"].fg)).toEqual([17, 34, 51]);
    expect(rgb(theme.styles["markup.heading.2"].fg)).toEqual([68, 85, 102]);
    expect(theme.styles["markup.heading.2"].attributes & TextAttributes.BOLD).toBe(0);
  } finally {
    await app.dispose();
  }
});
