import { link, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  capture,
  parseJson,
  StorageError,
  systemCode,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  cleanupLedgerSchema,
  daemonRegistrySchema,
  daemonRegistryV1Schema,
  type CleanupKind,
  type CleanupLedger,
  type CleanupReceipt,
  type DaemonRegistry,
  type RepositoryState,
  type WorkspaceSource,
} from "./daemon-protocol.ts";
import { withStateLock } from "./state-lock.ts";

export const emptyRegistry = (): DaemonRegistry => ({ version: 2, repositories: [] });

export type LoadedRegistry = {
  registry: DaemonRegistry;
  // The original v1 text, retained until a verified backup exists beside the new file.
  legacy?: string;
};

/** Daemon-wide cleanup ledger and its lock, beside `repositories.json` and `ui/`. */
export function cleanupLedgerPaths(daemonDirectory: string): { ledger: string; lock: string } {
  return {
    ledger: join(daemonDirectory, "workspace-cleanup.json"),
    lock: join(daemonDirectory, "workspace-cleanup.lock"),
  };
}

export const emptyCleanupLedger = (): CleanupLedger => ({ version: 1, revision: 0, receipts: [] });

/**
 * Serializes every master-ledger, registry and UI-state write of one daemon directory across
 * processes. Never nest it, and never hold it while acquiring a repository `state.lock`.
 */
export function withCleanupLock<T>(
  daemonDirectory: string,
  task: () => Promise<Result<T, ExpectedError>>,
): Promise<Result<T, ExpectedError>> {
  return withStateLock(cleanupLedgerPaths(daemonDirectory).lock, task);
}

/** Reads the master ledger. A missing ledger is empty; a corrupt one is an error, never empty. */
export async function readCleanupLedger(
  daemonDirectory: string,
): Promise<Result<CleanupLedger, ExpectedError>> {
  const read = await capture(() => readFile(cleanupLedgerPaths(daemonDirectory).ledger, "utf8"));
  if (!read.ok) {
    return read.error instanceof StorageError &&
      (read.error.systemCode === "ENOENT" || read.error.systemCode === "ENOTDIR")
      ? ok(emptyCleanupLedger())
      : read;
  }

  const parsed = parseJson(read.value, "workspace cleanup ledger");
  if (!parsed.ok || !Value.Check(cleanupLedgerSchema, parsed.value)) {
    return err(
      new StorageError("Invalid workspace cleanup ledger; the original file was retained."),
    );
  }

  return ok(parsed.value);
}

/** Replaces the master ledger atomically. Callers hold `withCleanupLock`. */
export function writeCleanupLedger(
  daemonDirectory: string,
  ledger: CleanupLedger,
): Promise<Result<void, ExpectedError>> {
  return capture(() =>
    atomicWrite(cleanupLedgerPaths(daemonDirectory).ledger, JSON.stringify(ledger)),
  );
}

export type CleanupScrubSets = { worktreeIds: Set<string>; sessionIds: Set<string> };

/**
 * Identities that a UI snapshot clean against `acknowledged` must not contain.
 *
 * Session IDs of every receipt stay deleted permanently: a reopened scope always starts new
 * conversations, so late callbacks never resurrect old ones. Worktree IDs are deleted while the
 * scope is not reopened, and also when its latest change is newer than the acknowledged revision,
 * because such a snapshot may still hold the scope's pre-deletion state.
 */
export function cleanupScrubSets(
  receipts: readonly CleanupReceipt[],
  acknowledged: number,
): CleanupScrubSets {
  const sets: CleanupScrubSets = { worktreeIds: new Set(), sessionIds: new Set() };
  for (const scope of cleanupScopes(receipts, acknowledged)) {
    for (const id of scope.sessionIds) sets.sessionIds.add(id);
    for (const id of scope.worktreeIds) sets.worktreeIds.add(id);
  }

  return sets;
}

/**
 * The deletion identities of one receipt that a snapshot clean against some revision must not
 * contain, with the repository that owned them. A worktree ID is a path that another repository
 * may own later, so consumers holding worktree-keyed state check `repositoryId` before scrubbing.
 */
export type CleanupScope = {
  readonly repositoryId: string;
  // A whole-repository receipt also owns UI-only historical keys not listed by the runtime.
  readonly wholeRepository?: boolean;
  readonly worktreeIds: readonly string[];
  readonly sessionIds: readonly string[];
};

/** Per-receipt form of `cleanupScrubSets`, under the same revision rules. */
export function cleanupScopes(
  receipts: readonly CleanupReceipt[],
  acknowledged: number,
): CleanupScope[] {
  return receipts.map((receipt) => ({
    repositoryId: receipt.repositoryId,
    wholeRepository:
      receipt.kind === "repository" &&
      (receipt.state !== "reopened" || receipt.revision > acknowledged),
    worktreeIds:
      receipt.state !== "reopened" || receipt.revision > acknowledged
        ? receipt.worktrees.map((tree) => tree.id)
        : [],
    sessionIds: receipt.sessionIds,
  }));
}

export type RegistryExclusion = {
  token: string;
  repositoryId: string;
  kind: CleanupKind;
  worktreePaths: readonly string[];
};

// `source` also removes launch contexts. Purged receipts omit it after purge applied it once, so
// an explicit later launch from a recreated path (which clears `cwdRemoved`) is not undone.
type RegistryScope = RegistryExclusion & { source: boolean };

/**
 * Daemon restoration state (`repositories.json`).
 *
 * It stores the workspace source reference, CHAT configuration and per-repository
 * restoration metadata. Current membership is never derived from it: repository entries
 * apply only to repositories that discovery finds through the source.
 *
 * Saves run under the daemon's cleanup lock and drop state of deleted scopes, so neither a stale
 * in-memory registry nor an interrupted v1 migration can restore it after cleanup.
 */
export class RestoreStateStore {
  private legacy: string | undefined;
  private tail: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  private readonly exclusions = new Map<string, RegistryScope>();

  constructor(private readonly path: string) {}

  get backupPath(): string {
    return `${this.path.replace(/\.json$/, "")}.v1.json`;
  }

  private get daemonDirectory(): string {
    return dirname(this.path);
  }

  /**
   * Immediately excludes a deletion scope from every later save in this process, before the
   * durable receipt exists. It stays in force until `release(token)` after a reopen.
   */
  exclude(scope: RegistryExclusion): void {
    this.exclusions.set(scope.token, {
      ...scope,
      worktreePaths: scope.worktreePaths.map((path) => resolve(path)),
      source: true,
    });
  }

  release(token: string): void {
    this.exclusions.delete(token);
  }

  // `null` means no registry exists yet; corrupt or unreadable files remain errors.
  async load(): Promise<Result<DaemonRegistry | null, ExpectedError>> {
    const read = await capture(() => readFile(this.path, "utf8"));
    if (!read.ok) {
      return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
        ? ok(null)
        : read;
    }

    const parsed = parseRegistry(read.value);
    if (!parsed.ok) {
      return parsed;
    }

    // Read after the registry: a purge records its fence before rewriting the registry, so any
    // unsanitized registry read here is matched by a receipt read below.
    const ledger = await readCleanupLedger(this.daemonDirectory);
    if (!ledger.ok) {
      return ledger;
    }
    this.legacy = parsed.value.legacy;

    return ok(sanitizeRegistry(parsed.value.registry, this.scopes(ledger.value)));
  }

  /**
   * Atomically replaces the registry. A v1 original is first copied to `repositories.v1.json`
   * (never overwriting an existing backup), so an interrupted migration loses nothing.
   */
  save(registry: DaemonRegistry): Promise<Result<void, ExpectedError>> {
    const snapshot = structuredClone(registry);
    const task = this.tail.then(() =>
      withCleanupLock(this.daemonDirectory, async () => {
        const ledger = await readCleanupLedger(this.daemonDirectory);
        if (!ledger.ok) return ledger;

        const text = JSON.stringify(sanitizeRegistry(snapshot, this.scopes(ledger.value)));
        return capture(async () => {
          const legacy = this.legacy;
          if (legacy !== undefined) {
            await backup(this.backupPath, legacy);
          }

          await atomicWrite(this.path, text, legacy);
          this.legacy = undefined;
        });
      }),
    );
    this.tail = task;

    return task;
  }

  /**
   * Removes a deleted scope from `repositories.json`, its v1 backup and crashed temporary files.
   * A pending v1 migration is completed with sanitized contents, so a stale reader of the
   * original can no longer publish it. Returns the registry callers adopt in memory.
   */
  purge(receipt: CleanupReceipt): Promise<Result<DaemonRegistry | null, ExpectedError>> {
    const scope: RegistryScope = {
      token: receipt.token,
      repositoryId: receipt.repositoryId,
      kind: receipt.kind,
      worktreePaths: receipt.worktrees.map((tree) => resolve(tree.path)),
      source: true,
    };
    const task = this.tail.then(() =>
      withCleanupLock(this.daemonDirectory, async () => {
        const ledger = await readCleanupLedger(this.daemonDirectory);
        if (!ledger.ok) return ledger;

        const scopes = [...this.scopes(ledger.value), scope];
        const registry = await this.purgeRegistry(scopes);
        if (!registry.ok) return registry;

        const backedUp = await this.purgeBackup(scopes);
        if (!backedUp.ok) return backedUp;

        const temporary = await removeTemporaryFiles(this.path, this.backupPath);
        return temporary.ok ? registry : temporary;
      }),
    );
    this.tail = task.then((result) => (result.ok ? ok(undefined) : result));

    return task;
  }

  private scopes(ledger: CleanupLedger): RegistryScope[] {
    const recorded = ledger.receipts
      .filter((receipt) => receipt.state !== "reopened")
      .map((receipt): RegistryScope => ({
        token: receipt.token,
        repositoryId: receipt.repositoryId,
        kind: receipt.kind,
        worktreePaths: receipt.worktrees.map((tree) => resolve(tree.path)),
        source: receipt.state === "fenced",
      }));

    return [...recorded, ...this.exclusions.values()];
  }

  private async purgeRegistry(
    scopes: readonly RegistryScope[],
  ): Promise<Result<DaemonRegistry | null, ExpectedError>> {
    const read = await capture(() => readFile(this.path, "utf8"));
    if (!read.ok) {
      return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
        ? ok(null)
        : read;
    }

    const parsed = parseRegistry(read.value);
    if (!parsed.ok) return parsed;

    const sanitized = sanitizeRegistry(parsed.value.registry, scopes);
    const legacy = parsed.value.legacy;
    const written = await capture(async () => {
      if (legacy !== undefined) {
        // Complete the migration with the usual verified backup; `purgeBackup` then removes
        // the deleted scope from that recovery copy as well.
        await backup(this.backupPath, legacy);
      }
      if (
        legacy !== undefined ||
        JSON.stringify(sanitized) !== JSON.stringify(parsed.value.registry)
      ) {
        await atomicWrite(this.path, JSON.stringify(sanitized), legacy ?? read.value);
      }
    });
    if (!written.ok) return written;
    this.legacy = undefined;

    return ok(sanitized);
  }

  private async purgeBackup(
    scopes: readonly RegistryScope[],
  ): Promise<Result<void, ExpectedError>> {
    const read = await capture(() => readFile(this.backupPath, "utf8"));
    if (!read.ok) {
      return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
        ? ok(undefined)
        : read;
    }

    const json = parseJson(read.value, "registry backup");
    if (!json.ok || !Value.Check(daemonRegistryV1Schema, json.value)) {
      // An unknown recovery file is not ours to rewrite; report it instead of guessing.
      return err(
        new StorageError("Registry backup is not a valid v1 registry; it was retained unchanged."),
      );
    }

    const sanitized = JSON.stringify(sanitizeLegacyRegistry(json.value, scopes));
    if (sanitized === read.value) return ok(undefined);

    return capture(() => atomicWrite(this.backupPath, sanitized, read.value));
  }
}

const within = (path: string, roots: readonly string[]): boolean => {
  const target = resolve(path);
  return roots.some((root) => target === root || target.startsWith(root + sep));
};

function sanitizeRegistry(
  registry: DaemonRegistry,
  scopes: readonly RegistryScope[],
): DaemonRegistry {
  if (!scopes.length) return registry;

  const deletedRepositories = new Set(
    scopes.filter((scope) => scope.kind === "repository").map((scope) => scope.repositoryId),
  );
  const paths = scopes.flatMap((scope) => scope.worktreePaths);
  const sourcePaths = scopes
    .filter((scope) => scope.source)
    .flatMap((scope) => scope.worktreePaths);
  const repositories = registry.repositories
    .filter((entry) => !deletedRepositories.has(entry.repositoryId))
    .map((entry) => {
      if (entry.cwd === undefined || !within(entry.cwd, paths)) return entry;
      const { cwd: _deleted, ...rest } = entry;
      return rest;
    });
  const result: DaemonRegistry = { ...registry, repositories };
  if (registry.source && sourcePaths.length) {
    result.source = sanitizeSource(registry.source, sourcePaths);
  }

  return result;
}

// Keeps the settings/workspace references and the historical cwd; only launch contexts go.
function sanitizeSource(source: WorkspaceSource, paths: readonly string[]): WorkspaceSource {
  const { contexts, ...rest } = source;
  const kept = (contexts ?? []).filter((path) => !within(path, paths));
  return {
    ...rest,
    ...(kept.length ? { contexts: kept } : {}),
    ...(source.cwdRemoved || within(source.cwd, paths) ? { cwdRemoved: true as const } : {}),
  };
}

type LegacyRegistry = Static<typeof daemonRegistryV1Schema>;

function sanitizeLegacyRegistry(
  registry: LegacyRegistry,
  scopes: readonly RegistryScope[],
): LegacyRegistry {
  const deletedRepositories = new Set(
    scopes.filter((scope) => scope.kind === "repository").map((scope) => scope.repositoryId),
  );
  const paths = scopes.flatMap((scope) => scope.worktreePaths);

  // A v1 registration requires its cwd, so a registration launched from a deleted path is dropped.
  return {
    ...registry,
    repositories: registry.repositories.filter(
      (entry) => !deletedRepositories.has(entry.repositoryId) && !within(entry.cwd, paths),
    ),
  };
}

// Temporary files of interrupted writes may still contain deleted paths. Every writer holds the
// cleanup lock, so no live temporary file exists while it is held.
async function removeTemporaryFiles(...files: string[]): Promise<Result<void, ExpectedError>> {
  return capture(async () => {
    const directory = dirname(files[0]!);
    const names = await readdir(directory).catch((error: unknown) => {
      if (systemCode(error) === "ENOENT") return [] as string[];
      throw error;
    });
    const prefixes = files.map((file) => `${basename(file)}.`);
    for (const name of names) {
      if (
        prefixes.some((prefix) => name.startsWith(prefix)) &&
        /\.[0-9a-f-]{36}\.tmp$/.test(name)
      ) {
        await rm(join(directory, name), { force: true });
      }
    }
  });
}

export function parseRegistry(text: string): Result<LoadedRegistry, StorageError> {
  const invalid = () =>
    err(new StorageError("Invalid shared daemon registry. The original file was not overwritten."));
  const json = parseJson(text, "shared daemon registry");
  if (!json.ok) {
    return invalid();
  }
  if (Value.Check(daemonRegistrySchema, json.value)) {
    return ok({ registry: json.value });
  }
  if (!Value.Check(daemonRegistryV1Schema, json.value)) {
    return invalid();
  }

  // v1 registrations become metadata only. Their paths never become current candidates and
  // their config is never promoted into a workspace source: the origin of v1 membership is unknown.
  const repositories = json.value.repositories.map(
    ({ repositoryId, active, config, cwd }): RepositoryState => ({
      repositoryId,
      active,
      cwd,
      ...(config ? { config } : {}),
    }),
  );

  return ok({
    registry: {
      version: 2,
      ...(json.value.chatConfig !== undefined ? { chatConfig: json.value.chatConfig } : {}),
      repositories,
    },
    legacy: text,
  });
}

/**
 * Applies a TUI's source to the remembered one. Same references in roots=[] mode keep each
 * explicit launch context so additional current-repository launches remain additive.
 * Different references replace the source; callers validate conflicts before committing.
 */
export function mergeSource(
  current: WorkspaceSource | undefined,
  next: WorkspaceSource,
): WorkspaceSource {
  if (!current || !sameReferences(current, next)) {
    return structuredClone(next);
  }

  // Launching again from a removed cwd is an explicit new launch context for that path.
  const relaunched = current.cwdRemoved === true && next.cwd === current.cwd;
  const { cwdRemoved, ...kept } = structuredClone(current);
  const contexts = [...new Set([...(current.contexts ?? []), next.cwd, ...(next.contexts ?? [])])]
    .filter((path) => path !== current.cwd)
    .slice(0, 256);

  return {
    ...kept,
    ...(contexts.length ? { contexts } : {}),
    ...(cwdRemoved && !relaunched ? { cwdRemoved } : {}),
  };
}

export function sameReferences(a: WorkspaceSource, b: WorkspaceSource): boolean {
  return (
    a.settings.path === b.settings.path &&
    a.settings.explicit === b.settings.explicit &&
    a.workspace.path === b.workspace.path &&
    a.workspace.explicit === b.workspace.explicit
  );
}

// A removed cwd is only a historical reference; with no other context the result is empty,
// and discovery must not substitute an arbitrary directory for it.
export function sourceContexts(source: WorkspaceSource): readonly string[] {
  return [...new Set([...(source.cwdRemoved ? [] : [source.cwd]), ...(source.contexts ?? [])])];
}

export function repositoryState(
  registry: DaemonRegistry,
  repositoryId: string,
): RepositoryState | undefined {
  return registry.repositories.find((state) => state.repositoryId === repositoryId);
}

// Replace or append one repository's metadata while preserving every unrelated entry.
export function withRepositoryState(
  registry: DaemonRegistry,
  state: RepositoryState,
): DaemonRegistry {
  const repositories = registry.repositories.some(
    (entry) => entry.repositoryId === state.repositoryId,
  )
    ? registry.repositories.map((entry) =>
        entry.repositoryId === state.repositoryId ? state : entry,
      )
    : [...registry.repositories, state];

  return { ...registry, repositories };
}

async function backup(path: string, text: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await withCleanup(
    async () => {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      try {
        // Publish a complete backup without replacing another migration's recovery source.
        await link(temporary, path);
      } catch (error) {
        if (systemCode(error) !== "EEXIST") throw error;
        if ((await readFile(path, "utf8")) !== text) {
          throw new StorageError(
            "Existing registry backup differs from the original; both files were retained.",
          );
        }
      }
    },
    () => rm(temporary, { force: true }),
  );
}

async function atomicWrite(path: string, text: string, expectedLegacy?: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await withCleanup(
    async () => {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      if (expectedLegacy !== undefined && (await readFile(path, "utf8")) !== expectedLegacy) {
        throw new StorageError(
          "Registry changed during migration; the current file and original backup were retained.",
        );
      }
      await rename(temporary, path);
    },
    () => rm(temporary, { force: true }),
  );
}
