export type MessageLevel = "info" | "success" | "warning" | "error";
export type NoticeOptions = { level?: MessageLevel; source?: string };
export type Notice = (text: string, options?: NoticeOptions) => void;
export type Message = { id: string; timestamp: number; level: MessageLevel; source: string; text: string; title?: string };

// Presentation lifetime is independent of retention. Dismissing a toast never removes its message.
export class Messages {
  private readonly entries: Message[] = [];
  private sequence = 0;
  get items(): readonly Message[] { return this.entries; }
  add(text: string, timestamp: number, options: NoticeOptions & { id?: string; title?: string } = {}): Message | undefined {
    if (!text.trim() || options.id && this.entries.some(item => item.id === options.id)) return;
    const message: Message = { id: options.id ?? `message:${++this.sequence}`, timestamp, level: options.level ?? "info", source: options.source ?? "Radian", text,
      ...(options.title ? { title: options.title } : {}) };
    this.entries.unshift(message);
    this.entries.length = Math.min(this.entries.length, 500);
    return message;
  }
}

export const messageLabels = { info: "Info", success: "Completed", warning: "Warning", error: "Failed" } satisfies Record<MessageLevel, string>;
export function messageText(text: string): string {
  return Bun.stripANSI(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
}
