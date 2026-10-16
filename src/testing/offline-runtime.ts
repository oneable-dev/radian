import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PiSessionOptions } from "../agents/pi-session-adapter.ts";

// These are scripted SDK responses, not a language model or a substitute for live-provider validation.
export async function offlineRuntime(directory: string): Promise<PiSessionOptions> {
  await mkdir(directory, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  modelRuntime.registerProvider("radian-offline", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"],
      contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const model = modelRuntime.getModel("radian-offline", "fixture");
  if (!model) throw new Error("Offline fixture model was not registered.");
  const streamFn: NonNullable<PiSessionOptions["streamFn"]> = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);
    const last = context.messages.at(-1);
    const input = last?.role === "user"
      ? (typeof last.content === "string" ? last.content : last.content.filter((part) => part.type === "text").map((part) => part.text).join("")) : "";
    const finish = (aborted = false): void => {
      options?.signal?.removeEventListener("abort", cancel);
      if (timer) clearTimeout(timer);
      if (aborted) message.stopReason = "aborted";
      if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
      else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => finish(true);
    stream.push({ type: "start", partial: message });
    if (options?.signal?.aborted) { finish(true); return stream; }
    options?.signal?.addEventListener("abort", cancel, { once: true });
    if (input === "slow") {
      const text = { type: "text" as const, text: "" };
      message.content.push(text);
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      let tick = 0;
      const step = (): void => {
        const delta = `Progress ${++tick}/40\n`;
        text.text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
        if (tick === 40) finish();
        else timer = setTimeout(step, 250);
      };
      timer = setTimeout(step, 250);
    } else if (["read", "write", "delegate"].includes(input)) {
      const tool = input === "read" ? { name: "read", arguments: { path: "workspace.txt" } }
        : input === "write" ? { name: "write", arguments: { path: "radian-probe.txt", content: "Offline SDK write probe\n" } }
        : { name: "radian_subagent", arguments: { name: "Worktree probe", task: "slow" } };
      message.content.push({ type: "toolCall", id: crypto.randomUUID(), ...tool });
      message.stopReason = "toolUse";
      finish();
    } else {
      const result = last?.role === "toolResult" ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "Offline SDK fixture: enter slow, read, write, or delegate.";
      message.content.push({ type: "text", text: result });
      finish();
    }
    return stream;
  };
  return { agentDir: directory, sessionDir: join(directory, "sessions"), modelRuntime, model, streamFn };
}

export function fixtureMessage(api: string, provider: string, model: string): AssistantMessage {
  return {
    role: "assistant", api, provider, model, content: [], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
