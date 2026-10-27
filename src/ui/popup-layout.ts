import { BoxRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { EmptyState } from "./empty-state.ts";
import type { SearchInput } from "./search-input.ts";

// Empty guidance decorates a viewport without replacing its keyboard/scroll owner.
export class PopupBody {
  readonly root: BoxRenderable;
  readonly empty: EmptyState;

  constructor(renderer: CliRenderer, id: string, content: Renderable) {
    this.root = new BoxRenderable(renderer, { id, width: "100%", flexGrow: 1, minWidth: 0, minHeight: 0,
      flexDirection: "column", overflow: "hidden" });
    this.empty = new EmptyState(renderer, `${id}-empty`);
    this.empty.root.position = "absolute"; this.empty.root.left = 0; this.empty.root.top = 0;
    this.empty.root.width = "100%"; this.empty.root.bottom = 0; this.empty.root.visible = false;
    this.root.add(content); this.root.add(this.empty.root);
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

const searchBottomGap = 1;

// Features own query, selection, commands and lifetimes; this owns only geometry.
export class SearchPopupLayout {
  readonly root: BoxRenderable;
  readonly candidates: BoxRenderable;
  readonly results: PopupBody;

  constructor(renderer: CliRenderer, private readonly options: SearchLayoutOptions) {
    this.root = new BoxRenderable(renderer, { id: `${options.id}-body`, flexGrow: 1, minWidth: 0, minHeight: 0, flexDirection: "row" });
    this.candidates = new BoxRenderable(renderer, { minWidth: 0, minHeight: 0, flexDirection: "column" });
    this.results = new PopupBody(renderer, `${options.id}-results`, options.list);
    options.search.field.marginBottom = searchBottomGap;
    this.candidates.add(options.search.field);
    if (options.message) this.candidates.add(options.message);
    this.candidates.add(this.results.root); this.root.add(this.candidates);
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
    // Split popups inset only their search/list column; previews use the full frame edge.
    this.candidates.paddingLeft = 1; this.candidates.paddingRight = split && wide ? 0 : 1;
    const pane = preview.body.root;
    pane.visible = Boolean(split && (wide || compactPreview));
    pane.width = wide ? `${preview.width}%` : "100%";
    pane.flexGrow = wide ? 0 : 1;
    pane.border = wide ? ["left"] : false; pane.paddingX = 0;
  }

  get listHeight(): number {
    const { search, message } = this.options;
    return this.results.root.visible ? this.results.root.height
      : this.root.height - (search.field.visible ? search.field.height + searchBottomGap : 0) - (message?.visible ? message.height : 0);
  }
}

// Activity lives on the frame edge, never in a reserved popup header or over its content.
export function attachPopupActivity(panel: BoxRenderable, activity: Renderable): void {
  activity.position = "absolute"; activity.top = -1; activity.right = 0; activity.zIndex = 1;
  panel.add(activity);
}

export function centerPopup(panel: BoxRenderable, width: number, height: number, availableWidth: number, availableHeight: number): void {
  const columns = Math.max(1, Math.min(availableWidth, Math.floor(width)));
  const rows = Math.max(1, Math.min(availableHeight, Math.floor(height)));
  panel.width = columns; panel.height = rows;
  // Native geometry getters still describe the previous frame during resize.
  panel.left = Math.floor((availableWidth - columns) / 2);
  panel.top = Math.floor((availableHeight - rows) / 2);
}
