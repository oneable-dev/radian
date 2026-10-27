import { BoxRenderable, type CliRenderer, type Renderable } from "@opentui/core";
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
    if (options.preview) this.root.add(options.preview.body.root);
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
    if (!preview) return;
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

// Activity lives on the frame edge, never in a reserved popup header or over its content.
export function attachPopupActivity(panel: BoxRenderable, activity: Renderable): void {
  activity.position = "absolute";
  activity.top = panel.border ? -1 : 0;
  activity.right = 0;
  activity.zIndex = 1;
  panel.add(activity);
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
