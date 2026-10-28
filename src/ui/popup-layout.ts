import { BoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";
import { truncateCells } from "./text.ts";
import { EmptyState } from "./empty-state.ts";
import type { SearchInput } from "./search-input.ts";

// Empty guidance decorates a viewport without replacing its keyboard/scroll owner.
export class PopupBody {
  readonly root: BoxRenderable;
  readonly empty: EmptyState;

  constructor(renderer: CliRenderer, id: string, content: Renderable) {
    this.root = new BoxRenderable(renderer, {
      id,
      width: "100%",
      flexGrow: 1,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
      overflow: "hidden",
    });
    this.empty = new EmptyState(renderer, `${id}-empty`);
    this.empty.root.position = "absolute";
    this.empty.root.left = 0;
    this.empty.root.top = 0;
    this.empty.root.width = "100%";
    this.empty.root.bottom = 0;
    this.empty.root.visible = false;
    this.root.add(content);
    this.root.add(this.empty.root);
  }

  showEmpty(title?: string, description?: string): void {
    this.empty.root.visible = Boolean(title);
    this.empty.update({ icon: "", title: title ?? "", ...(description ? { description } : {}) });
  }
}

type SearchLayoutOptions = {
  id: string;
  search: SearchInput;
  message?: Renderable;
  list: Renderable;
  preview?: { body: PopupBody; width: number };
};

// Features own query, selection, commands and lifetimes; this owns only geometry.
export class SearchPopupLayout {
  readonly root: BoxRenderable;
  readonly candidates: BoxRenderable;
  readonly results: PopupBody;

  constructor(
    renderer: CliRenderer,
    private readonly options: SearchLayoutOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: `${options.id}-body`,
      flexGrow: 1,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "row",
    });
    this.candidates = new BoxRenderable(renderer, {
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
    });
    this.results = new PopupBody(renderer, `${options.id}-results`, options.list);
    options.search.field.marginBottom = 0;
    this.results.root.paddingX = 1;
    this.candidates.add(options.search.field);
    if (options.message) {
      options.message.marginX = 1;
      this.candidates.add(options.message);
    }

    this.candidates.add(this.results.root);
    this.root.add(this.candidates);
    if (options.preview) {
      this.root.add(options.preview.body.root);
    }

    this.resize(false);
  }

  resize(wide: boolean, compactPreview = false, previewEnabled = true): void {
    const { preview, list } = this.options;
    const split = preview && previewEnabled;
    const showList = !split || wide || !compactPreview;

    list.visible = this.results.root.visible = showList;
    this.root.flexDirection = wide ? "row" : "column";
    this.candidates.width = split && wide ? `${100 - preview.width}%` : "100%";
    this.candidates.flexGrow = showList ? 1 : 0;
    if (!preview) {
      return;
    }

    const pane = preview.body.root;
    pane.visible = Boolean(split && (wide || compactPreview));
    pane.width = wide ? `${preview.width}%` : "100%";
    pane.flexGrow = wide ? 0 : 1;
    pane.border = wide ? ["left"] : false;
    pane.paddingX = 0;
  }

  get listHeight(): number {
    const { search, message } = this.options;

    return this.results.root.visible
      ? this.results.root.height
      : this.root.height -
          (search.field.visible ? search.field.height : 0) -
          (message?.visible ? message.height : 0);
  }
}

export type PopupActivityState = {
  pending: boolean;
  hasContent: boolean;
  message: string;
  body?: Renderable | undefined;
  anchor?: Renderable | undefined;
};

// Features own operation lifetimes; placement follows the data currently available to the user.
export function attachPopupActivity(
  renderer: CliRenderer,
  panel: BoxRenderable,
  activity: Renderable,
  state: () => PopupActivityState,
): BoxRenderable {
  const feedback = new BoxRenderable(renderer, {
    id: `${activity.id}-feedback`,
    position: "absolute",
    height: 1,
    flexDirection: "row",
    gap: 1,
    zIndex: 10,
    visible: false,
  });
  const label = new TextRenderable(renderer, {
    id: `${activity.id}-message`,
    height: 1,
    wrapMode: "none",
    selectable: false,
  });

  feedback.add(activity);
  feedback.add(label);
  panel.add(feedback);
  uiTheme(renderer).bindStyles(feedback, (styles) => {
    feedback.backgroundColor = styles["ui.popup"].bg;
    paintText(label, styles["ui.muted"]);
  });
  feedback.onLifecyclePass = () => {
    const current = state();
    const body = current.body ?? panel;

    feedback.visible = activity.visible && body.width > 0 && body.height > 0;
    if (!feedback.visible) {
      return;
    }

    // A spinner's minimum-visible tail never retains a loading message or obscures ready data.
    const centered = current.pending && !current.hasContent;
    label.visible = centered;
    label.content = centered ? truncateCells(current.message, Math.max(0, body.width - 4)) : "";
    label.width = Bun.stringWidth(label.plainText);

    const width = Math.min(body.width, activity.width + (label.visible ? label.width + 1 : 0));
    feedback.width = width;

    const borderLeft =
      panel.border === true || (Array.isArray(panel.border) && panel.border.includes("left"))
        ? 1
        : 0;
    const borderTop =
      panel.border === true || (Array.isArray(panel.border) && panel.border.includes("top"))
        ? 1
        : 0;

    feedback.left =
      body.x -
      panel.x -
      borderLeft +
      (centered ? Math.floor((body.width - width) / 2) : Math.max(0, body.width - width - 1));

    const y =
      body.y +
      (centered
        ? Math.floor((body.height - 1) / 2)
        : Math.max(0, Math.min(body.height - 1, (current.anchor?.y ?? body.y) - body.y)));
    const borderBottom =
      panel.border === true || (Array.isArray(panel.border) && panel.border.includes("bottom"))
        ? 1
        : 0;

    // A body can scroll outside its popup; activity must never leak onto the underlying workbench.
    feedback.visible = y >= panel.y + borderTop && y < panel.y + panel.height - borderBottom;
    feedback.top = y - panel.y - borderTop;
  };

  return feedback;
}

type PopupSize = { width: number; height: number };

// Centered overlays share cell-based presets; anchored cards and pane-sized views keep their own geometry.
export const POPUP_SIZES = {
  compact: { width: 64, height: 10 },
  standard: { width: 100, height: 24 },
  expanded: { width: 160, height: 36 },
} as const satisfies Record<string, PopupSize>;

const POPUP_VIEWPORT = { width: 0.9, height: 0.8 } as const;

export function getPopupSize(
  size: PopupSize,
  availableWidth: number,
  availableHeight: number,
): PopupSize {
  return {
    width: Math.max(1, Math.floor(Math.min(size.width, availableWidth * POPUP_VIEWPORT.width))),
    height: Math.max(1, Math.floor(Math.min(size.height, availableHeight * POPUP_VIEWPORT.height))),
  };
}

export function centerPopup(
  panel: BoxRenderable,
  size: PopupSize,
  availableWidth: number,
  availableHeight: number,
): PopupSize {
  const dimensions = getPopupSize(size, availableWidth, availableHeight);
  panel.width = dimensions.width;
  panel.height = dimensions.height;
  // Native geometry getters still describe the previous frame during resize.
  panel.left = Math.floor((availableWidth - dimensions.width) / 2);
  panel.top = Math.floor((availableHeight - dimensions.height) / 2);

  return dimensions;
}
