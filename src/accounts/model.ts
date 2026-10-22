import { Type, type Static } from "typebox";
import type { CompletionItem } from "../agents/completion.ts";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const id = Type.String({ minLength: 1, maxLength: 4096 });
const authType = Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]);
export const accountInfoSchema = Type.Object({ id, provider: id, label: Type.String(), type: authType, usedBy: Type.Array(id) });
export type AccountInfo = Static<typeof accountInfoSchema>;
export const accountsCatalogSchema = Type.Object({ revision: Type.Integer({ minimum: 0 }), worktreeId: id,
  accounts: Type.Array(accountInfoSchema), selections: Type.Record(Type.String(), id),
  existingAccounts: Type.Optional(Type.Array(Type.Object({ provider: id, name: Type.String(), type: authType }))),
  warning: Type.Optional(Type.String()),
  providers: Type.Array(Type.Object({ id, name: Type.String(), methods: Type.Array(Type.Object({ id: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]), name: Type.String() })) })),
});
export type AccountsCatalog = Static<typeof accountsCatalogSchema>;
const promptSchema = Type.Object({ id, type: Type.Union([Type.Literal("text"), Type.Literal("secret"), Type.Literal("select"), Type.Literal("manual_code")]), message: Type.String(),
  placeholder: Type.Optional(Type.String()), options: Type.Optional(Type.Array(Type.Object({ id, label: Type.String(), description: Type.Optional(Type.String()) }))) });
export const loginViewSchema = Type.Object({ id, revision: Type.Integer({ minimum: 0 }), status: Type.Union([Type.Literal("pending"), Type.Literal("complete"), Type.Literal("cancelled"), Type.Literal("error")]),
  events: Type.Array(Type.Object({ message: Type.String(), url: Type.Optional(Type.String()), code: Type.Optional(Type.String()) })),
  prompt: Type.Optional(promptSchema), account: Type.Optional(accountInfoSchema), error: Type.Optional(Type.String()),
});
export type LoginView = Static<typeof loginViewSchema>;
export const accountRequestSchema = Type.Union([
  Type.Object({ type: Type.Literal("list"), worktreeId: id }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("select"), worktreeId: id, provider: id, accountId: Type.Union([id, Type.Null()]), revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("delete"), worktreeId: id, accountId: id, revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("login"), worktreeId: id, provider: id, method: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]), label: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("poll"), worktreeId: id, flowId: id, revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("answer"), worktreeId: id, flowId: id, promptId: id, value: Type.String({ maxLength: 65536 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("cancel"), worktreeId: id, flowId: id }, { additionalProperties: false }),
]);
export type AccountRequest = Static<typeof accountRequestSchema>;
export const accountReplySchema = Type.Union([
  Type.Object({ kind: Type.Literal("catalog"), catalog: accountsCatalogSchema, warning: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal("login"), login: loginViewSchema }),
]);
export type AccountReply = Static<typeof accountReplySchema>;
export const accountsCommand: CompletionItem = { kind: "command", value: "accounts", description: "Switch accounts or sign in to a new account" };
export function parseAccountsCommand(text: string): Result<boolean, InputError> {
  const command = text.trim();
  if (!/^\/accounts(?:\s|$)/u.test(command)) return ok(false);
  return command.slice(9).trim() ? err(new InputError("Usage: /accounts (manage accounts in the popup; no arguments).")) : ok(true);
}
