import { basename } from "node:path";
import { capture, collectCleanup, InputError, knownError, PtyError, reportUnexpected, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { Repository } from "../workspace/model.ts";
import type { TerminalInfo } from "../runtime/protocol.ts";
import { OwnedProcesses } from "./owned-processes.ts";
import { PtySession } from "../runtime/pty/session.ts";
import { ShellHandshake, shellHandshake, shellSupervisorSource } from "./shell-supervisor.ts";

type TerminalRecord = {
  session: PtySession; handshake: ShellHandshake; owner?: OwnedProcesses;
  title: string; shellPid: number; phase: "starting" | "open" | "closing"; startSent: boolean;
  cleanup?: Promise<Result<void, ExpectedError>>;
};
export class TerminalSessions {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly numbers = new Map<string, number>();
  private stopping = false;
  constructor(private readonly repositories: readonly Repository[], private readonly changed: () => void,
    private readonly supervisorDirectory: string, private readonly clean = false,
    private readonly observe: (task: Promise<Result<void, ExpectedError>>) => void = reportCleanup) {}
  get infos(): TerminalInfo[] {
    return [...this.records.values()].filter((record) => record.phase === "open").map((record) => ({
      ...record.session.info, title: record.title, shellPid: record.shellPid,
    }));
  }
  get closingCount(): number { return [...this.records.values()].filter((record) => record.phase === "closing").length; }
  async create(worktreeId: string, size: { cols: number; rows: number }): Promise<Result<string, ExpectedError>> {
    if (this.stopping) return err(new PtyError("PTY_UNAVAILABLE", "Terminal runtime is stopping."));
    const worktree = this.repositories.flatMap((repo) => repo.worktrees).find((tree) => tree.id === worktreeId);
    if (!worktree) return err(new InputError("Unknown terminal worktree."));
    const shell = Bun.which(this.clean ? "/bin/sh" : process.env.SHELL || "/bin/sh");
    if (!shell) return err(new PtyError("PTY_UNAVAILABLE", "The configured SHELL executable is unavailable."));
    return capture(async () => {
      let session: PtySession | undefined;
      const handshake = new ShellHandshake((code) => {
        session?.finish(code);
        // Cleanup belongs to the runtime, even while no TUI is attached. The same
        // verified close path collects any jobs left after the shell has exited.
        if (session && this.records.get(session.id)?.phase === "open") this.observe(this.close(session.id));
      });
      session = new PtySession(worktreeId, { argv: [process.execPath, "--no-env-file", "--config=/dev/null", "--eval", shellSupervisorSource], cwd: this.supervisorDirectory, size,
        detached: true, scrollback: 5000, ipc: (message) => handshake.receive(message),
        ...(this.clean ? { env: { HISTFILE: "/dev/null", ENV: undefined, BASH_ENV: undefined, PS1: "radian$ ", PROMPT_COMMAND: undefined } } : {}),
      }, this.changed);
      const number = (this.numbers.get(worktreeId) ?? 0) + 1; this.numbers.set(worktreeId, number);
      const record: TerminalRecord = { session, handshake, title: `Terminal ${number} · ${basename(shell)}`, shellPid: session.process.pid, phase: "starting", startSent: false };
      this.records.set(session.id, record);
      void session.settled.then(() => handshake.fail(new PtyError("PTY_OWNERSHIP_LOST", "Shell ownership supervisor ended.")));
      try {
        const owner = OwnedProcesses.capture({ pid: session.process.pid, alive: () => session!.process.exitCode === null });
        if (!owner.ok) throw owner.error;
        record.owner = owner.value;
        await shellHandshake(handshake.ready.promise, "supervisor startup");
        if (this.stopping || record.phase !== "starting") throw new PtyError("PTY_UNAVAILABLE", "Terminal creation was interrupted by shutdown.");
        record.startSent = true; session.process.send({ type: "start", argv: [shell, "-i"], cwd: worktree.path });
        record.shellPid = await shellHandshake(handshake.started.promise, "startup");
        if (this.stopping || record.phase !== "starting") throw new PtyError("PTY_UNAVAILABLE", "Terminal creation was interrupted by shutdown.");
        if (session.info.exited) throw new PtyError("PTY_NOT_OPEN", "Shell exited during startup; no replacement was created.");
        record.phase = "open"; this.changed(); return session.id;
      } catch (error) {
        const cleanup = await this.close(session.id);
        if (!cleanup.ok) throw new AggregateError([error, cleanup.error], "Shell startup and cleanup failed.");
        throw error;
      }
    });
  }
  attach(id: string, lease: string): Result<Response, ExpectedError> {
    const record = this.open(id); return record.ok ? record.value.session.attach(lease) : record;
  }
  detach(id: string, lease: string): void {
    const record = this.records.get(id);
    if (record?.session.lease === lease) record.session.lease = null;
  }
  input(id: string, lease: string, bytes: Uint8Array): Result<void, ExpectedError> {
    const owned = this.owned(id, lease); if (!owned.ok) return owned;
    if (owned.value.info.exited) return err(new PtyError("PTY_NOT_OPEN", "Shell exited; create a new terminal explicitly."));
    try { owned.value.input(bytes); return ok(undefined); }
    catch (error) { const known = knownError(error); if (known) return err(known); throw error; }
  }
  async resize(id: string, lease: string, cols: number, rows: number): Promise<Result<void, ExpectedError>> {
    const owned = this.owned(id, lease); if (!owned.ok) return owned;
    return capture(() => owned.value.resize(cols, rows, lease));
  }
  async scroll(id: string, lease: string, lines: number): Promise<Result<void, ExpectedError>> {
    const owned = this.owned(id, lease); if (!owned.ok) return owned;
    return capture(() => owned.value.scroll(lines, lease));
  }
  private open(id: string): Result<TerminalRecord, PtyError> {
    const record = this.records.get(id);
    return record?.phase === "open" ? ok(record) : err(new PtyError("PTY_NOT_OPEN", "Terminal is not open."));
  }
  private owned(id: string, lease: string): Result<PtySession, PtyError> {
    const record = this.open(id); if (!record.ok) return record;
    return record.value.session.lease === lease ? ok(record.value.session) : err(new PtyError("PTY_BUSY", "Terminal attachment changed; input was not sent."));
  }
  close(id: string): Promise<Result<void, ExpectedError>> {
    const record = this.records.get(id); if (!record) return Promise.resolve(ok(undefined));
    if (record.cleanup) return record.cleanup;
    record.phase = "closing"; record.session.lease = null; this.changed();
    record.cleanup = capture(async () => {
      if (record.startSent) {
        // Acknowledge the launch gate before enumerating children; no delayed launch may
        // race an empty process list and escape cleanup when its supervisor is removed.
        if (record.session.process.exitCode !== null || !record.owner) throw new PtyError("PTY_OWNERSHIP_LOST", `Terminal ${id} anchor ${record.session.process.pid} ended; refusing unverified process cleanup.`);
        record.session.process.send({ type: "freeze" });
        await shellHandshake(record.handshake.frozen.promise, "cleanup handshake");
        const stopped = await record.owner.stopChildren(record.shellPid); if (!stopped.ok) throw stopped.error;
      }
      const disposed = await record.session.dispose(); if (!disposed.ok) throw disposed.error;
      this.records.delete(id); this.changed();
    }).finally(() => { delete record.cleanup; });
    return record.cleanup;
  }
  async stop(): Promise<Result<void, ExpectedError>> {
    this.stopping = true;
    return collectCleanup([...this.records.keys()].map((id) => this.close(id)), "Terminal cleanup failed.");
  }
}

function reportCleanup(task: Promise<Result<void, ExpectedError>>): void {
  void task.then((result) => {
    if (!result.ok) console.error(`[radian:${result.error.code}] Automatic terminal cleanup failed`, result.error);
  }).catch((error: unknown) => { reportUnexpected(error, "automatic terminal cleanup"); });
}
