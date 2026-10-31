import { CancelledError, InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { SupervisorCommand } from "./subagent-tools.ts";

export type SubagentQuestion = {
  readonly id: string;
  readonly message: string;
  readonly createdAt: number;
};
export type SubagentEvent =
  | { type: "progress"; message: string; createdAt: number }
  | { type: "question"; question: SubagentQuestion }
  | { type: "question-settled"; questionId: string };
type Pending = { question: SubagentQuestion; finish(result: Result<unknown, ExpectedError>): void };

/** One child-to-owner channel. Closing always releases outstanding question tool calls. */
export class SubagentChannel {
  readonly progress: { message: string; createdAt: number }[] = [];
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly changed: (event: SubagentEvent) => void) {}

  get questions(): readonly SubagentQuestion[] {
    return [...this.pending.values()].map((entry) => entry.question);
  }

  contact(
    command: SupervisorCommand,
    signal?: AbortSignal,
  ): Promise<Result<unknown, ExpectedError>> {
    if (this.closed || signal?.aborted) return Promise.resolve(err(new CancelledError()));
    if (command.action === "proposal")
      return Promise.resolve(
        err(new InputError("Planning proposals belong to the owning runtime.")),
      );
    if (!command.message.trim())
      return Promise.resolve(err(new InputError("A supervisor message cannot be empty.")));
    if (command.action === "progress") {
      const update = { message: command.message, createdAt: Date.now() };
      this.progress.push(update);
      if (this.progress.length > 16) this.progress.shift();
      this.changed({ type: "progress", ...update });
      return Promise.resolve(ok({ recorded: true }));
    }
    if (this.pending.size >= 8)
      return Promise.resolve(err(new InputError("Too many unanswered questions in this run.")));
    const question = { id: crypto.randomUUID(), message: command.message, createdAt: Date.now() };
    const response = Promise.withResolvers<Result<unknown, ExpectedError>>();
    const cancel = () => this.pending.get(question.id)?.finish(err(new CancelledError()));
    this.pending.set(question.id, {
      question,
      finish: (result) => {
        this.pending.delete(question.id);
        signal?.removeEventListener("abort", cancel);
        response.resolve(result);
        this.changed({ type: "question-settled", questionId: question.id });
      },
    });
    signal?.addEventListener("abort", cancel, { once: true });
    this.changed({ type: "question", question });
    return response.promise;
  }

  reply(questionId: string, message: string): Result<unknown, ExpectedError> {
    const pending = this.pending.get(questionId);
    if (!pending || this.closed)
      return err(new InputError("This question is no longer waiting for an answer."));
    if (!message.trim()) return err(new InputError("A reply cannot be empty."));
    pending.finish(ok({ questionId, message }));
    return ok({ delivered: true, questionId });
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values())
      pending.finish(
        err(new CancelledError("The owning run closed before this question was answered.")),
      );
  }
}
