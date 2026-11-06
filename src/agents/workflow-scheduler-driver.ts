import type { ExpectedError } from "../errors.ts";
import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import type { WorkflowDocument } from "./task-workflow.ts";
import {
  activeAdmission,
  planningProfileSnapshot,
  type SchedulerAdmission,
  type SchedulerEvent,
  type SchedulerIntent,
  type SchedulerRun,
} from "./workflow-scheduler.ts";

type WithoutEnvelope<E> = E extends SchedulerEvent ? Omit<E, "id" | "at"> : never;
export type SchedulerInput = WithoutEnvelope<SchedulerEvent>;
type Observation<E> = E extends SchedulerInput ? Omit<E, "invocationId"> : never;

export type PlanningSchedulerControl =
  | { kind: "started"; invocationId: string; baselineRevision: number }
  | { kind: "paused" | "resumed" | "cancelled" | "restarted"; invocationId: string };

export type SchedulerHost = {
  profiles(): Result<AgentProfile[], ExpectedError>;
  snapshot?(profile: AgentProfile): ReturnType<typeof planningProfileSnapshot>;
  runs(): readonly SchedulerRun[];
  /** The host uses mutateWorkflow(requireVersion: 2), never an implicit migration. */
  commit(
    event: SchedulerEvent,
    runs: readonly SchedulerRun[],
  ): Promise<Result<{ doc: WorkflowDocument; intents: SchedulerIntent[] }, ExpectedError>>;
  launch(
    operationId: string,
    admission: SchedulerAdmission,
    profile: AgentProfile,
  ): Promise<Result<string, ExpectedError>>;
  stop(operationId: string): Promise<Result<void, ExpectedError>>;
  report(error: ExpectedError): void;
  unexpected(error: unknown): void;
};

/** Single-host serialization and operation claims; durable facts are always committed first. */
export class PlanningSchedulerDriver {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly launches = new Map<string, Promise<void>>();
  private readonly stops = new Map<string, Promise<Result<void, ExpectedError>>>();
  private readonly cleanupFailures = new Set<string>();
  private invocationId: string | undefined;
  private sequence = 0;
  private closed = false;
  private owned = true;

  get ownsWorkflow(): boolean {
    return this.owned && !this.closed;
  }
  private readonly generation = crypto.randomUUID();

  constructor(private readonly host: SchedulerHost) {}

  async control(command: PlanningSchedulerControl): Promise<Result<void, ExpectedError>> {
    this.invocationId = command.invocationId;
    if (command.kind === "started") this.owned = true;
    if (command.kind === "cancelled" || command.kind === "paused") {
      for (const operationId of this.cleanupFailures) this.stops.delete(operationId);
      this.cleanupFailures.clear();
    }
    const committed = await this.send(command);
    if (!committed.ok) return committed;
    if (command.kind === "cancelled" || command.kind === "paused") {
      const results = await Promise.all(this.stops.values());
      const failure = results.find((result) => !result.ok);
      if (failure && !failure.ok) return failure;
    }
    if (command.kind === "cancelled") this.owned = false;
    return ok(undefined);
  }

  observe(event: Observation<SchedulerInput>): void {
    if (!this.invocationId || this.closed) return;
    this.background(this.send({ ...event, invocationId: this.invocationId } as SchedulerInput));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.tail;
    await Promise.all(this.launches.values());
    await Promise.all(this.stops.values());
    await this.tail;
  }

  send(event: SchedulerInput): Promise<Result<void, ExpectedError>> {
    if (this.closed) return Promise.resolve(ok(undefined));
    const task = this.tail.then(() => this.apply(event));
    this.tail = task.catch((error) => this.host.unexpected(error));
    return task;
  }

  private async apply(input: SchedulerInput): Promise<Result<void, ExpectedError>> {
    if (this.closed) return ok(undefined);
    const profiles = this.host.profiles();
    if (!profiles.ok) return profiles;
    const event = {
      ...input,
      id: `scheduler:${this.generation}:${this.sequence++}`,
      at: Date.now(),
      profiles: Object.fromEntries(
        profiles.value.map((profile) => [profile.name, this.snapshot(profile)]),
      ),
      capacity: 5,
      retainedCapacity: 128,
    } as SchedulerEvent;
    const committed = await this.host.commit(event, this.host.runs());
    if (!committed.ok) return committed;
    if (this.closed) return ok(undefined);
    const doc = committed.value.doc;
    if (doc.version !== 2 || !doc.scheduler)
      return err(
        new WorkflowError("WORKFLOW_CONFLICT", "Scheduler commit did not return v2 facts."),
      );
    for (const intent of committed.value.intents) {
      const admission = doc.scheduler.admissions[intent.operationId]!;
      if (intent.kind === "stop") {
        if (!this.stops.has(intent.operationId)) {
          const stop = async (): Promise<Result<void, ExpectedError>> => {
            // The stop reason is already durable. A not-yet-reserved launch must recheck it;
            // an initializing handle is stopped through the ordinary confirmed-cleanup path.
            const result = await this.host.stop(intent.operationId);
            const recorded = await this.send(
              result.ok
                ? {
                    kind: "run-settled",
                    invocationId: admission.invocationId!,
                    operationId: intent.operationId,
                    outcome: admission.stopReason === "cancelled" ? "cancelled" : "interrupted",
                  }
                : {
                    kind: "cleanup-uncertain",
                    invocationId: admission.invocationId!,
                    operationId: intent.operationId,
                  },
            );
            if (!recorded.ok || !result.ok) this.cleanupFailures.add(intent.operationId);
            if (!recorded.ok) return recorded;
            return result;
          };
          const cleanup = stop();
          this.stops.set(intent.operationId, cleanup);
          this.background(cleanup);
        }
        continue;
      }
      if (this.launches.has(intent.operationId) || !activeAdmission(admission.state)) continue;
      const assigned =
        doc.tasks[admission.taskId]![admission.role === "worker" ? "lead" : admission.role];
      const profile = profiles.value.find((item) => item.name === assigned?.profile);
      if (!profile) continue;
      // The claim is installed before the first await; reentrant events cannot launch twice.
      const launch = this.launch(intent.operationId, admission, profile);
      this.launches.set(intent.operationId, launch);
      void launch.catch((error) => this.host.unexpected(error));
    }
    return ok(undefined);
  }

  private snapshot(profile: AgentProfile) {
    return this.host.snapshot?.(profile) ?? planningProfileSnapshot(profile);
  }

  private async launch(
    operationId: string,
    admission: SchedulerAdmission,
    profile: AgentProfile,
  ): Promise<void> {
    const launching = await this.host.commit(
      {
        kind: "launching",
        operationId,
        invocationId: admission.invocationId!,
        id: `scheduler:${this.generation}:launch:${operationId}`,
        at: Date.now(),
        profiles: {},
        capacity: 0,
      },
      this.host.runs(),
    );
    if (!launching.ok) {
      this.host.report(launching.error);
      this.launches.delete(operationId);
      return;
    }
    if (this.closed) return;
    const current = launching.value.doc;
    const facts = current.version === 2 ? current.scheduler?.admissions[operationId] : undefined;
    const invocation =
      current.version === 2
        ? current.scheduler?.invocations.find((item) => item.id === admission.invocationId)
        : undefined;
    if (facts?.stopReason || facts?.state !== "launching" || invocation?.state !== "active") return;
    const snapshot = this.snapshot(profile);
    const snapshotMatches =
      JSON.stringify({ ...snapshot, purpose: facts.effectiveProfile.purpose }) ===
      JSON.stringify(facts.effectiveProfile);
    const result = snapshotMatches
      ? await this.host.launch(operationId, facts, profile)
      : err(
          new WorkflowError(
            "WORKFLOW_CONFLICT",
            "Effective profile changed after admission; a new planning request is required.",
          ),
        );
    const live = this.host.runs().find((run) => run.operationId === operationId && run.active);
    const outcome =
      result.ok || live
        ? { kind: "run-started" as const, runId: result.ok ? result.value : live!.id }
        : result.error.code === "DELEGATION_CAPACITY_EXCEEDED"
          ? { kind: "capacity-deferred" as const }
          : { kind: "run-settled" as const, outcome: "failed" as const };
    this.background(this.send({ ...outcome, operationId, invocationId: admission.invocationId! }));
    if (!result.ok && live)
      this.background(
        this.send({
          kind: "cleanup-uncertain",
          operationId,
          invocationId: admission.invocationId!,
        }),
      );
    if (!result.ok && result.error.code !== "DELEGATION_CAPACITY_EXCEEDED")
      this.host.report(result.error);
  }

  private background(task: Promise<Result<void, ExpectedError>>): void {
    void task
      .then((result) => {
        if (!result.ok) this.host.report(result.error);
      })
      .catch((error) => this.host.unexpected(error));
  }
}
