export type MessageLevel = "success" | "warning" | "error";
// Accept SDK Info at the notice boundary, but never store or present it as a message.
export type NoticeOptions = { level?: MessageLevel | "info"; source?: string };
export type Notice = (text: string, options?: NoticeOptions) => void;
export type Message = {
  id: string;
  timestamp: number;
  level: MessageLevel;
  source: string;
  text: string;
  title?: string;
};

// Presentation lifetime is independent of retention. Dismissing a toast never removes its message.
export class Messages {
  private readonly entries: Message[] = [];
  private sequence = 0;
  get items(): readonly Message[] {
    return this.entries;
  }
  add(
    text: string,
    timestamp: number,
    options: NoticeOptions & { id?: string; title?: string } = {},
  ): Message | undefined {
    const level = options.level;
    if (
      !level ||
      level === "info" ||
      !text.trim() ||
      (options.id && this.entries.some((item) => item.id === options.id))
    )
      return;
    const message: Message = {
      id: options.id ?? `message:${++this.sequence}`,
      timestamp,
      level,
      source: options.source ?? "Radian",
      text,
      ...(options.title ? { title: options.title } : {}),
    };
    this.entries.unshift(message);
    this.entries.length = Math.min(this.entries.length, 500);
    return message;
  }
}

export const messageLabels = {
  success: "Completed",
  warning: "Warning",
  error: "Failed",
} satisfies Record<MessageLevel, string>;
export function messageText(text: string): string {
  // oxlint-disable-next-line eslint/no-control-regex -- Strip unsafe terminal controls while preserving tabs and newlines.
  return Bun.stripANSI(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
}
