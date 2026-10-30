// CODE identities remain worktree-scoped on disk and on the existing wire protocol.
// CHAT has no repository or worktree; its discriminator must never be interpreted as a path.
export type SessionScope =
  | { readonly kind: "code"; readonly worktreeId: string }
  | { readonly kind: "chat" };

export const CHAT_SCOPE_ID = "radian:chat";
