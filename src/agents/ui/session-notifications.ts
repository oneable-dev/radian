import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";
import type { SessionNotification } from "../session-notification.ts";
import type { SessionResult } from "../session-attention.ts";
import { formatRunDuration } from "./run-completion.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText, type StyleGroup } from "../../ui/theme-styles.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { icons } from "../../icons.ts";
import { messageLabels, messageText, type Message } from "../../ui/messages.ts";

type Notification = SessionNotification | Message;

type Timer = ReturnType<CliRenderer["clock"]["setTimeout"]>;
type Toast = { notification: Notification; root: BoxRenderable; heading: TextRenderable; task: TextRenderable; location: TextRenderable;
  expiry: Timer; animation?: Timer };
const labels = { complete: "Completed", error: "Failed", unfinished: "Stopped", cancelled: "Cancelled" } satisfies Record<SessionResult["outcome"], string>;
const colors = { complete: "status.success", error: "status.error", unfinished: "status.warning", cancelled: "status.warning" } as const satisfies Record<SessionResult["outcome"], StyleGroup>;

// Own only presentation and timers. Neither dismissal nor expiry acknowledges a result.
export class SessionNotificationStack {
  readonly root: BoxRenderable;
  private readonly pending: Notification[] = [];
  private readonly visible: Toast[] = [];
  private capacity = 0;
  private hidden = false;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly open: (notification: Notification) => void) {
    // The overlay occupies only its cards, never a full-screen pointer-catching backdrop.
    this.root = new BoxRenderable(renderer, { id: "session-notifications", position: "absolute", top: 1, right: 2,
      width: 52, height: 0, flexDirection: "column", gap: 1, zIndex: 7000, visible: false });
    this.root.on(RenderableEvents.DESTROYED, () => this.dispose());
    uiTheme(renderer).bind(this.root, () => { for (const toast of this.visible) this.paint(toast); });
    renderer.on("resize", this.resize); this.resize();
  }

  show(notification: Notification): void {
    if (this.disposed || this.pending.some(item => item.id === notification.id) || this.visible.some(item => item.notification.id === notification.id)) return;
    this.pending.push(notification); this.pump();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (!this.disposed) this.root.visible = !hidden && this.visible.length > 0;
  }

  retain(sessionIds: ReadonlySet<string>): void {
    for (let index = this.pending.length - 1; index >= 0; index--) if (isClosedSession(this.pending[index]!, sessionIds)) this.pending.splice(index, 1);
    for (const toast of [...this.visible]) if (isClosedSession(toast.notification, sessionIds)) this.remove(toast);
    this.pump();
  }

  private resize = (): void => {
    if (this.disposed) return;
    this.root.right = this.renderer.width > 54 ? 2 : 1;
    const top = this.renderer.height > 6 ? 1 : 0;
    this.root.top = top;
    this.root.width = Math.max(1, Math.min(52, this.renderer.width - 2));
    this.capacity = this.renderer.width < 8 ? 0 : Math.min(3, Math.floor((this.renderer.height - top) / 6));
    while (this.visible.length > this.capacity) {
      const toast = this.visible.at(-1)!;
      this.pending.unshift(toast.notification); this.remove(toast);
    }
    for (const toast of this.visible) this.paint(toast);
    this.pump();
  };

  private pump(): void {
    if (this.disposed) return;
    while (this.visible.length < this.capacity && this.pending.length) this.mount(this.pending.shift()!);
    this.root.visible = !this.hidden && this.visible.length > 0;
    this.root.height = Math.max(0, this.visible.length * 6 - 1);
  }

  private mount(notification: Notification): void {
    const root = new BoxRenderable(this.renderer, { id: `session-toast:${notification.id}`, width: "100%", height: 5, flexShrink: 0,
      flexDirection: "column", border: true, paddingX: 1, opacity: 0.5,
      onMouseDown: event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); this.dismiss(notification.id); this.open(notification);
      }, onMouseScroll: event => event.stopPropagation() });
    const header = new BoxRenderable(this.renderer, { width: "100%", height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    const heading = new TextRenderable(this.renderer, { height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
    const task = new TextRenderable(this.renderer, { height: 1, width: "100%", wrapMode: "none", selectable: false });
    const location = new TextRenderable(this.renderer, { height: 1, width: "100%", wrapMode: "none", selectable: false });
    header.add(heading); root.add(header); root.add(task); root.add(location); this.root.add(root);
    const brief = "result" in notification ? notification.result.outcome === "complete" : notification.level === "success";
    const expiry = this.renderer.clock.setTimeout(() => this.dismiss(notification.id), brief ? 5000 : 8000);
    const toast: Toast = { notification, root, heading, task, location, expiry };
    this.visible.push(toast); this.paint(toast);
    const started = this.renderer.clock.now();
    toast.animation = this.renderer.clock.setInterval(() => {
      const progress = Math.min(1, (this.renderer.clock.now() - started) / 160);
      root.opacity = 0.5 + progress * 0.5;
      if (progress === 1 && toast.animation !== undefined) { this.renderer.clock.clearInterval(toast.animation); delete toast.animation; }
    }, 40);
  }

  private paint(toast: Toast): void {
    const styles = uiTheme(this.renderer).styles;
    const group: StyleGroup = "result" in toast.notification ? colors[toast.notification.result.outcome] : `status.${toast.notification.level}`;
    const status = styles[group];
    toast.root.backgroundColor = styles["ui.popup"].bg;
    toast.root.borderColor = status.fg;
    paintText(toast.heading, status); paintText(toast.task, styles["ui.label"]);
    paintText(toast.location, styles["ui.muted"]);
    // Layout getters still describe the previous frame when a card first arrives.
    const width = Math.max(0, Math.min(52, this.renderer.width - 2) - 4);
    if (!("result" in toast.notification)) {
      const item = toast.notification;
      toast.heading.content = truncateCells(singleLine(messageText(item.title ?? messageLabels[item.level])), width);
      toast.task.content = truncateCells(singleLine(messageText(item.text)), width);
      toast.location.content = truncateCells(singleLine(messageText(item.source)), width);
      return;
    }
    const { result, durationMs } = toast.notification;
    const elapsed = durationMs === undefined ? "" : ` · ${formatRunDuration(durationMs)}`;
    toast.heading.content = truncateCells(labels[result.outcome] + elapsed, width);
    toast.task.content = truncateCells(excerpt(result.request?.text || "AI session"), width);
    const worktree = excerpt(toast.notification.worktree), branch = excerpt(toast.notification.branch ?? "detached HEAD");
    toast.location.content = truncateCells(`${icons.folder} ${worktree} / ${icons.branch} ${branch}`, width);
  }

  private dismiss(id: string): void {
    const toast = this.visible.find(item => item.notification.id === id);
    if (toast) this.remove(toast);
    this.pump();
  }

  private remove(toast: Toast): void {
    this.renderer.clock.clearTimeout(toast.expiry);
    if (toast.animation !== undefined) this.renderer.clock.clearInterval(toast.animation);
    this.visible.splice(this.visible.indexOf(toast), 1); toast.root.destroyRecursively();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.renderer.off("resize", this.resize);
    for (const toast of [...this.visible]) this.remove(toast);
    this.pending.length = 0;
    if (!this.root.isDestroyed) this.root.destroyRecursively();
  }
}

function isClosedSession(notification: Notification, sessionIds: ReadonlySet<string>): boolean {
  return "sessionId" in notification && !sessionIds.has(notification.sessionId);
}

function excerpt(value: string): string { return singleLine(Bun.stripANSI(value.slice(0, 512))); }
