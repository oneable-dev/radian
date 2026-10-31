import { InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { AgentProfile } from "./agent-profiles.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const name = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Pi preserves extension settings. Bind commands to profiles, never to model copies.
export function resolveCommandAgent(
  command: string,
  settings: unknown,
  profiles: readonly AgentProfile[] | (() => Result<readonly AgentProfile[], ExpectedError>),
): Result<AgentProfile | null, ExpectedError> {
  if (!object(settings)) return err(new InputError("Invalid command agent settings."));
  const bindings = settings.commandAgents;
  if (bindings === undefined) return ok(null);
  if (!object(bindings))
    return err(new InputError("commandAgents must map commands to profile names."));
  for (const [key, value] of Object.entries(bindings)) {
    if (!name.test(key) || typeof value !== "string" || !name.test(value)) {
      return err(
        new InputError("commandAgents accepts command and profile names, not model settings."),
      );
    }
  }
  if (!Object.hasOwn(bindings, command)) return ok(null);
  const profileName = String(bindings[command]);
  const available = typeof profiles === "function" ? profiles() : ok(profiles);
  if (!available.ok) return available;
  const selected = available.value.find((profile) => profile.name === profileName);
  return selected
    ? ok(selected)
    : err(new InputError(`Command ${command} requires unavailable agent profile ${profileName}.`));
}
