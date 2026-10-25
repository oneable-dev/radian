import { RGBA, TextAttributes, type TextBufferRenderable, type TextChunk, type StyleDefinitionInput } from "@opentui/core";
import type { UiColors } from "./theme.ts";
import { blendColors, neutralColor } from "./color.ts";
import { styleGroups, type StyleGroup, type StyleOverrides } from "./theme-style-config.ts";
export { styleGroups, type StyleGroup, type StyleOverride, type StyleOverrides } from "./theme-style-config.ts";

export type UiStyle = Readonly<{ fg: RGBA; bg: RGBA | undefined; attributes: number }>;
const style = (fg: RGBA, bg?: RGBA, attributes = 0): UiStyle => ({ fg, bg, attributes });
const bold = TextAttributes.BOLD, underline = TextAttributes.UNDERLINE;

// Shared defaults are intentional; popup backgrounds follow Normal unless explicitly overridden.
const definitions = {
  "ui.text": (c: UiColors) => style(c.text, c.panel),
  "ui.label": (c: UiColors) => style(c.text),
  "ui.muted": (c: UiColors) => style(c.muted),
  "ui.border": (c: UiColors) => style(blendColors(c.panel, c.text, 0.22)),
  "ui.focusBorder": (c: UiColors) => style(c.accent),
  "ui.input": (c: UiColors) => style(c.text, c.surface),
  "ui.inputFocused": (c: UiColors) => style(c.text, c.selected),
  "ui.placeholder": (c: UiColors) => style(c.muted),
  "ui.selection": (c: UiColors) => style(c.text, c.selected),
  "ui.selectionInactive": (c: UiColors) => style(c.text, c.surface),
  "ui.button": (c: UiColors) => style(c.accent),
  "ui.buttonFocused": (c: UiColors) => style(c.accent, c.selected),
  "ui.buttonActive": (c: UiColors) => style(c.text, undefined, bold | underline),
  "ui.buttonInactive": (c: UiColors) => style(c.muted),
  "ui.tab": (c: UiColors) => style(c.muted),
  "ui.tabActive": (c: UiColors) => style(c.text, undefined, bold),
  "ui.workTabActive": (c: UiColors) => style(c.text, undefined, bold | underline),
  "ui.workTabFocused": (c: UiColors) => style(c.muted, undefined, underline),
  "ui.popup": (c: UiColors) => style(c.text, c.panel),
  "ui.backdrop": (c: UiColors) => style(c.text, RGBA.fromValues(0, 0, 0, 0)),
  "ui.popupTitle": (c: UiColors) => style(c.accent),
  "ui.popupBorder": (c: UiColors) => style(c.accent),
  "ui.scrollbar": (c: UiColors) => style(c.muted, c.panel),
  "completion.item": (c: UiColors) => style(c.text, c.panel),
  "completion.description": (c: UiColors) => style(c.muted),
  "completion.selected": (c: UiColors) => style(c.accent, c.panel),
  "footer.key": (c: UiColors) => style(c.keyword),
  "footer.description": (c: UiColors) => style(c.muted),
  "footer.identity": (c: UiColors) => style(c.text, c.surface),
  "footer.accent": (c: UiColors) => style(c.accent),
  "status.working": (c: UiColors) => style(c.accent),
  "status.success": (c: UiColors) => style(c.success),
  "status.error": (c: UiColors) => style(c.error),
  "status.warning": (c: UiColors) => style(c.warning),
  "status.attention": (c: UiColors) => style(c.attention),
  "status.info": (c: UiColors) => style(c.accent),
  "status.unknown": (c: UiColors) => style(c.muted),
  "status.elapsed": (c: UiColors) => style(c.muted),
  "metadata.model": (c: UiColors) => style(c.success),
  "metadata.effort": (c: UiColors) => style(c.keyword),
  "metadata.fastOn": (c: UiColors) => style(c.number),
  "metadata.fastOff": (c: UiColors) => style(c.muted),
  "metadata.meter": (c: UiColors) => style(c.accent),
  "syntax.text": (c: UiColors) => style(c.text),
  "syntax.comment": (c: UiColors) => style(c.muted),
  "syntax.string": (c: UiColors) => style(c.success),
  "syntax.keyword": (c: UiColors) => style(c.keyword),
  "syntax.number": (c: UiColors) => style(c.number),
  "syntax.function": (c: UiColors) => style(c.info),
  "syntax.type": (c: UiColors) => style(c.warning),
  "syntax.constant": (c: UiColors) => style(c.number),
  "syntax.operator": (c: UiColors) => style(c.keyword),
  "markup.heading": (c: UiColors) => style(c.text, undefined, bold),
  "markup.heading.1": (c: UiColors) => style(c.text, undefined, bold),
  "markup.heading.2": (c: UiColors) => style(c.text, undefined, bold),
  "markup.heading.3": (c: UiColors) => style(c.text, undefined, bold),
  "markup.heading.4": (c: UiColors) => style(c.text, undefined, bold),
  "markup.heading.5": (c: UiColors) => style(c.text, undefined, bold),
  "markup.heading.6": (c: UiColors) => style(c.text, undefined, bold),
  "markup.strong": (c: UiColors) => style(c.text, undefined, bold),
  "markup.italic": (c: UiColors) => style(c.text, undefined, TextAttributes.ITALIC),
  "markup.inlineCode": (c: UiColors) => style(c.success),
  "markup.link": (c: UiColors) => style(c.info, undefined, underline),
  "markup.tableBorder": (c: UiColors) => style(c.muted),
  "transcript.user": (c: UiColors) => style(c.text, blendColors(c.panel, c.accent, 0.10)),
  "transcript.tool": (c: UiColors) => style(c.text, blendColors(c.panel, c.info, 0.09)),
  "transcript.notice": (c: UiColors) => style(c.text, blendColors(c.panel, c.warning, 0.08)),
  "transcript.toolHeader": (c: UiColors) => style(c.info),
  "transcript.thinking": (c: UiColors) => style(neutralColor(c.panel, c.text), c.panel, TextAttributes.ITALIC),
  "transcript.elapsed": (c: UiColors) => style(neutralColor(c.panel, c.text)),
  "transcript.skill": (c: UiColors) => style(c.keyword, undefined, bold),
  "transcript.selection": (c: UiColors) => style(c.text, blendColors(c.panel, c.accent, 0.38)),
  "sidebar.item": (c: UiColors) => style(c.text),
  "sidebar.selected": (c: UiColors) => style(c.accent),
  "sidebar.branch": (c: UiColors) => style(c.muted),
  "prompt.input": (c: UiColors) => style(c.text, c.surface),
  "branding.provider": (c: UiColors) => style(c.text, c.panel, bold),
  "branding.logo": (c: UiColors) => style(blendColors(c.panel, c.muted, 0.4)),
  "prompt.attachment": (c: UiColors) => style(c.accent, c.selected),
  "diff.added": (c: UiColors) => style(c.success, c.added),
  "diff.removed": (c: UiColors) => style(c.error, c.removed),
  "diff.lineNumber": (c: UiColors) => style(c.muted, c.surface),
  "git.added": (c: UiColors) => style(c.success),
  "git.removed": (c: UiColors) => style(c.error),
  "git.modified": (c: UiColors) => style(c.warning),
  "git.hash": (c: UiColors) => style(c.warning),
  "git.currentRef": (c: UiColors) => style(c.accent),
  "git.graph.1": (c: UiColors) => style(c.success),
  "git.graph.2": (c: UiColors) => style(c.info),
  "git.graph.3": (c: UiColors) => style(c.warning),
  "git.graph.4": (c: UiColors) => style(c.error),
  "git.graph.5": (c: UiColors) => style(c.accent),
  "git.graph.6": (c: UiColors) => style(c.keyword),
  "git.graph.7": (c: UiColors) => style(c.number),
  "git.graph.8": (c: UiColors) => style(c.text),
} satisfies Record<StyleGroup, (colors: UiColors) => UiStyle>;

export type UiStyles = Readonly<Record<StyleGroup, UiStyle>>;
export const selectionGroups = ["ui.selection", "ui.selectionInactive", "ui.inputFocused", "ui.buttonFocused", "ui.buttonActive", "ui.tabActive",
  "ui.workTabActive", "ui.workTabFocused", "completion.selected", "transcript.selection", "prompt.attachment"] as const satisfies readonly StyleGroup[];

export function resolveStyles(colors: UiColors, overrides: StyleOverrides = {}): UiStyles {
  const normalBackground = overrides["ui.text"]?.bg;
  return Object.fromEntries(styleGroups.map((group) => {
    const base = definitions[group](colors);
    const background = group === "ui.popup" && normalBackground ? RGBA.fromHex(normalBackground) : base.bg;
    const inherited = group.startsWith("markup.heading.") ? overrides["markup.heading"] : undefined;
    const value = { ...inherited, ...overrides[group] };
    let attributes = base.attributes;
    for (const [key, flag] of [["bold", bold], ["italic", TextAttributes.ITALIC], ["underline", underline]] as const) {
      if (value[key] !== undefined) attributes = value[key] ? attributes | flag : attributes & ~flag;
    }
    return [group, { fg: value.fg === undefined ? base.fg : RGBA.fromHex(value.fg),
      bg: value.bg === undefined ? background : value.bg === null ? undefined : RGBA.fromHex(value.bg), attributes }];
  })) as Record<StyleGroup, UiStyle>;
}

export function sameStyles(a: UiStyles, b: UiStyles): boolean {
  return styleGroups.every((key) => a[key].fg.equals(b[key].fg) && a[key].attributes === b[key].attributes
    && (a[key].bg === b[key].bg || !!a[key].bg && !!b[key].bg && a[key].bg.equals(b[key].bg)));
}

const transparent = RGBA.fromValues(0, 0, 0, 0);
// Some native setters require a color even when removing an explicit background.
export const styleBackground = (value: UiStyle): RGBA => value.bg ?? transparent;

export function paintText(node: TextBufferRenderable, value: UiStyle): void {
  node.fg = value.fg; node.bg = value.bg; node.attributes = value.attributes;
}
export const styleChunk = (text: string, value: UiStyle): TextChunk => ({ __isChunk: true, text, fg: value.fg,
  ...(value.bg ? { bg: value.bg } : {}), attributes: value.attributes });
export const syntaxDefinition = (value: UiStyle): StyleDefinitionInput => ({ fg: value.fg, ...(value.bg ? { bg: value.bg } : {}),
  bold: !!(value.attributes & bold), italic: !!(value.attributes & TextAttributes.ITALIC), underline: !!(value.attributes & underline) });

export function codeStyles(styles: UiStyles): Record<string, StyleDefinitionInput> {
  const tokens = { default: "syntax.text", keyword: "syntax.keyword", string: "syntax.string", number: "syntax.number",
    comment: "syntax.comment", function: "syntax.function", type: "syntax.type", constant: "syntax.constant", operator: "syntax.operator" } as const;
  return Object.fromEntries(Object.entries(tokens).map(([token, group]) => [token, syntaxDefinition(styles[group])]));
}
