import { Type, type Static } from "typebox";

const path = Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" });

export const repositoryRegistrationSchema = Type.Object(
  {
    repositoryId: path,
    cwd: path,
    config: Type.Optional(path),
  },
  { additionalProperties: false },
);

export type RepositoryRegistration = Static<typeof repositoryRegistrationSchema>;

// A configuration file reference. `explicit` preserves the missing-file contract:
// an explicitly selected file must exist, while an implicit default may be absent.
const fileReferenceSchema = Type.Object(
  { path, explicit: Type.Boolean() },
  { additionalProperties: false },
);

/**
 * The minimal reference from which current workspace membership is re-derived.
 *
 * It names the selected unified settings file, the legacy/override workspace file and the
 * launch context used by `roots: []`. It deliberately contains no resolved roots and no
 * discovered repositories: the latest file contents and the filesystem decide membership.
 */
export const workspaceSourceSchema = Type.Object(
  {
    settings: fileReferenceSchema,
    workspace: fileReferenceSchema,
    cwd: path,
    // Further explicit launch contexts of TUIs that shared the same references in roots=[] mode.
    contexts: Type.Optional(Type.Array(path, { maxItems: 256 })),
    // `cwd` belonged to a deleted workspace scope. It is retained only as the historical
    // reference and is no longer a launch context, so discovery never fabricates it again.
    cwdRemoved: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

export type WorkspaceSource = Static<typeof workspaceSourceSchema>;

export const workspaceRequestSchema = Type.Object(
  { source: workspaceSourceSchema, attachChat: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

// Per-repository restoration metadata. It is applied to discovered repositories only and
// never makes a repository a current candidate. `cwd` survives only from v1 registrations.
export const repositoryStateSchema = Type.Object(
  {
    repositoryId: path,
    active: Type.Boolean(),
    config: Type.Optional(path),
    // Freeze the original default-file location without turning an absent default into an explicit file.
    implicitConfig: Type.Optional(path),
    cwd: Type.Optional(path),
  },
  { additionalProperties: false },
);

export type RepositoryState = Static<typeof repositoryStateSchema>;

export const daemonRegistryV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    chatConfig: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    repositories: Type.Array(
      Type.Object(
        {
          ...repositoryRegistrationSchema.properties,
          active: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const daemonRegistrySchema = Type.Object(
  {
    version: Type.Literal(2),
    source: Type.Optional(workspaceSourceSchema),
    chatConfig: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    repositories: Type.Array(repositoryStateSchema),
  },
  { additionalProperties: false },
);

export type DaemonRegistry = Static<typeof daemonRegistrySchema>;

export const scopeWorktreeSchema = Type.Object({ id: path, path }, { additionalProperties: false });

export type ScopeWorktree = Static<typeof scopeWorktreeSchema>;

export const cleanupKindSchema = Type.Union([
  Type.Literal("repository"),
  Type.Literal("worktrees"),
]);

export type CleanupKind = Static<typeof cleanupKindSchema>;

/**
 * A durable workspace-deletion receipt. `fenced` blocks new work and persisted writes for the
 * scope; `purged` means every owned file was removed; `reopened` means a fresh generation may
 * use the same identity again. Receipts store identities only, never conversation contents.
 */
export const cleanupReceiptSchema = Type.Object(
  {
    token: Type.String({ pattern: "^[A-Za-z0-9-]{8,128}$" }),
    repositoryId: path,
    kind: cleanupKindSchema,
    worktrees: Type.Array(scopeWorktreeSchema, { maxItems: 4096 }),
    sessionIds: Type.Array(path, { maxItems: 65536 }),
    // Master-ledger revision of the receipt's latest change (fence, added sessions, purge or
    // reopen). UI stores compare it with the revision they acknowledged at save time.
    revision: Type.Integer({ minimum: 1 }),
    state: Type.Union([Type.Literal("fenced"), Type.Literal("purged"), Type.Literal("reopened")]),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type CleanupReceipt = Static<typeof cleanupReceiptSchema>;

export const cleanupLedgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    revision: Type.Integer({ minimum: 0 }),
    receipts: Type.Array(cleanupReceiptSchema, { maxItems: 1024 }),
  },
  { additionalProperties: false },
);

export type CleanupLedger = Static<typeof cleanupLedgerSchema>;
