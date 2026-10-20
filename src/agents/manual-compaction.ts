import type { AgentSession, CompactionResult, InlineExtension } from "@earendil-works/pi-coding-agent";
import { AgentRunError, CancelledError, InputError, knownError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

// Pi reports ordinary compaction validation/provider failures with untyped Error
// objects. Observe preparation and actual provider outcomes rather than matching
// English messages, while preserving unexpected programming exceptions.
export class ManualCompaction {
  private prepared: (() => void) | undefined;
  readonly extension: InlineExtension = { name: "radian-compaction", factory: (pi) => {
    pi.on("session_before_compact", (event) => { if (event.reason === "manual") this.prepared?.(); });
  } };

  async run(session: AgentSession, instructions: string | undefined, accepted?: () => void): Promise<Result<CompactionResult, ExpectedError>> {
    if (!session.model) return err(new InputError("Select a model before compacting."));
    const branch = session.sessionManager.getBranch();
    if (!session.messages.length || branch.at(-1)?.type === "compaction") return err(new InputError("No new context is available to compact."));
    let prepared = false, cancelled = false, providerFailure: string | undefined;
    const previous = session.agent.streamFunction;
    const original = previous;
    const observations: Promise<void>[] = [];
    const stream: NonNullable<typeof previous> = (...args) => {
      const response = original(...args);
      observations.push(Promise.resolve(response).then((events) => events.result()).then((message) => {
        if (message.stopReason === "aborted") cancelled = true;
        else if (message.stopReason !== "stop" || !message.content.some((part) => part.type === "text" && part.text.trim())) {
          providerFailure = message.errorMessage ?? `Summary response was not complete (${message.stopReason}).`;
        }
      }, () => { /* The SDK call below owns stream rejections and their original cause. */ }));
      return response;
    };
    this.prepared = () => { prepared = true; accepted?.(); };
    const unsubscribe = session.subscribe((event) => { if (event.type === "compaction_end" && event.reason === "manual") cancelled ||= event.aborted; });
    session.agent.streamFunction = stream;
    try {
      return ok(await session.compact(instructions));
    } catch (error) {
      await Promise.all(observations);
      const known = knownError(error); if (known) return err(known);
      if (cancelled) return err(new CancelledError("Context compaction was cancelled.", { cause: error }));
      if (providerFailure) return err(new AgentRunError(`Context compaction failed: ${providerFailure}`, { cause: error }));
      // Only Pi's pre-preparation validation uses a plain Error. TypeError,
      // RangeError, and failures after preparation retain their original stacks.
      if (!prepared && error instanceof Error && error.constructor === Error) return err(new InputError("The session has too little new context to compact.", { cause: error }));
      throw error;
    } finally {
      if (session.agent.streamFunction === stream) session.agent.streamFunction = previous;
      unsubscribe(); this.prepared = undefined;
    }
  }
}
