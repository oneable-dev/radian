import type { WorkView } from "../runtime/protocol.ts";

// CHAT is app-scoped; the other views retain their worktree-local state.
export type AppView = "chat" | WorkView;
