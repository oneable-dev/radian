import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { capture, InputError, parseJson, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { commandIds, contexts, defaultBindings, inScope, isCommand, type CommandId, type KeyContext, type KeyScope } from "./commands.ts";

export type Binding = { command: CommandId; keys: readonly string[]; displayKeys: readonly string[]; scope: KeyScope };
const aliases: Record<string, string> = { enter: "return", esc: "escape", pgup: "pageup", pgdn: "pagedown", " ": "space", "+": "plus" };
const named = new Set(["space", "plus", "return", "escape", "tab", "backspace", "delete", "insert", "home", "end", "up", "down", "left", "right", "pageup", "pagedown"]);
const scopes = new Set<string>([...contexts, "global", "app", "pty"]);
const pageCommands = new Set<CommandId>(["transcript.page-up", "transcript.page-down", "terminal.copy-page-up", "terminal.copy-page-down"]);

function chord(value: string): string | null {
  const parts = value.toLowerCase().split("+");
  let name = parts.pop(); if (!name) return null;
  name = aliases[name] ?? name;
  const modifiers = parts.map((part) => part === "control" ? "ctrl" : ["option", "meta"].includes(part) ? "alt" : part);
  if (new Set(modifiers).size !== modifiers.length || modifiers.some((part) => !["ctrl", "alt", "shift", "super"].includes(part))) return null;
  if (!named.has(name) && [...name].length !== 1 && !/^f([1-9]|[12]\d|3[0-5])$/.test(name)) return null;
  return [...["ctrl", "alt", "shift", "super"].filter((part) => modifiers.includes(part)), name].join("+");
}
function sequence(value: string, leader?: readonly string[]): string[] | null {
  const result: string[] = [];
  for (const part of value.trim().split(/\s+/)) {
    if (part.toLowerCase() === "<leader>") { if (!leader) return null; result.push(...leader); }
    else { const key = chord(part); if (!key) return null; result.push(key); }
  }
  return result.length && result.length <= 8 ? result : null;
}
export function keyToken(key: { name: string; ctrl: boolean; meta: boolean; option: boolean; shift: boolean; super?: boolean }): string {
  const name = aliases[key.name.toLowerCase()] ?? key.name.toLowerCase();
  return [key.ctrl && "ctrl", (key.meta || key.option) && "alt", key.shift && "shift", key.super && "super", name].filter(Boolean).join("+");
}
const labels: Record<string, string> = {
  space: "Space", return: "CR", escape: "Esc", tab: "Tab", backspace: "BS", delete: "Del", insert: "Insert",
  home: "Home", end: "End", up: "Up", down: "Down", left: "Left", right: "Right", pageup: "PageUp", pagedown: "PageDown",
  "<": "lt", "|": "Bar", "\\": "Bslash",
};
const modifierLabels: Record<string, string> = { ctrl: "C", alt: "M", shift: "S", super: "D" };
export function formatKeys(keys: readonly string[]): string {
  return keys.map((key) => {
    if (key === "<leader>") return key;
    const parts = key.split("+"), name = parts.pop()!;
    const special = labels[name] ?? (/^f\d+$/u.test(name) ? name.toUpperCase() : undefined);
    const label = special ?? (name === "plus" ? "+" : name);
    if (!parts.length) return special ? `<${label}>` : label;
    // Printable shifted letters are ordinary uppercase mappings in Neovim (G, V, Y).
    if (parts.length === 1 && parts[0] === "shift" && /^[a-z]$/u.test(name)) return name.toUpperCase();
    return `<${[...parts.map((part) => modifierLabels[part]), label].join("-")}>`;
  }).join("");
}

// Bare arrows are implicit navigation; modified keys and sequences still need hints.
export function isImplicitArrowBinding(binding: Binding): boolean {
  return binding.keys.length === 1 && ["up", "down", "left", "right"].includes(binding.keys[0]!);
}

export class Keymap {
  constructor(readonly bindings: readonly Binding[], readonly leader: readonly string[], readonly timeoutMs: number) {}
  bound(firstKey: string, context: KeyContext): boolean { return this.bindings.some((binding) => binding.keys[0] === firstKey && inScope(binding.scope, context)); }
  hint(command: CommandId, context: KeyContext): string {
    const match = this.bindings.find((binding) => binding.command === command && inScope(binding.scope, context) && !isImplicitArrowBinding(binding));
    return match ? formatKeys(match.displayKeys) : "";
  }
  hints(command: CommandId, context: KeyContext): string {
    return this.bindings.filter((binding) => binding.command === command && inScope(binding.scope, context) && !isImplicitArrowBinding(binding)).map((binding) => formatKeys(binding.displayKeys)).join("/");
  }
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function parseKeymap(value: unknown, platform: NodeJS.Platform = process.platform): Result<Keymap, InputError> {
  const invalid = (message: string) => err(new InputError(`Invalid keybindings: ${message}`));
  if (!object(value) || Object.keys(value).some((key) => !["leader", "timeoutMs", "bindings"].includes(key))) return invalid("expected leader, timeoutMs and/or bindings.");
  const leaderText = value.leader ?? "ctrl+space";
  const timeout = value.timeoutMs ?? 1000;
  if (typeof leaderText !== "string") return invalid("leader must be a key sequence.");
  const leader = sequence(leaderText); if (!leader) return invalid("leader is empty or invalid.");
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > 5000) return invalid("timeoutMs must be an integer between 100 and 5000.");
  const overrides = value.bindings ?? {};
  if (!object(overrides) || Object.keys(overrides).some((name) => !isCommand(name))) return invalid("unknown command in bindings.");
  const defaults = defaultBindings(platform), bindings: Binding[] = [];
  for (const command of commandIds) {
    const choices = Object.hasOwn(overrides, command) ? overrides[command] : defaults[command];
    if (!Array.isArray(choices)) return invalid(`${command} must be an array (use [] to disable it).`);
    for (const choice of choices) {
      const input: unknown = typeof choice === "string" ? { keys: choice, scope: "global" } : choice;
      if (!object(input) || Object.keys(input).some((key) => !["keys", "scope"].includes(key)) || typeof input.keys !== "string") return invalid(`${command} has an invalid binding.`);
      const scope = input.scope ?? "global";
      if (typeof scope !== "string" || !scopes.has(scope)) return invalid(`${command} has an unknown scope.`);
      const displayKeys = sequence(input.keys, ["<leader>"]); if (!displayKeys) return invalid(`${command} has an invalid key sequence.`);
      // Keep logical leader tokens for hints; only routing and conflict checks use expanded keys.
      const keys = displayKeys.flatMap((key) => key === "<leader>" ? leader : [key]);
      if (keys.length > 8) return invalid(`${command} has an invalid key sequence.`);
      // An explicit leader owns its prefix over optional default Ctrl+B/F paging.
      // PageUp/Down stay available; explicit command overrides still report conflicts.
      if (!Object.hasOwn(overrides, command) && pageCommands.has(command) && keys.length === 1
        && ["ctrl+b", "ctrl+f"].includes(keys[0]!) && keys[0] === leader[0]) continue;
      // Membership above validates the runtime scope before it enters the typed keymap.
      bindings.push({ command, keys, displayKeys, scope: scope as KeyScope });
    }
  }
  for (const [index, a] of bindings.entries()) for (const b of bindings.slice(index + 1)) {
    if (!contexts.some((context) => inScope(a.scope, context) && inScope(b.scope, context))) continue;
    const length = Math.min(a.keys.length, b.keys.length);
    if (a.keys.slice(0, length).every((key, i) => key === b.keys[i])) return invalid(`${a.command} and ${b.command} have conflicting/prefix bindings (${formatKeys(a.keys)} / ${formatKeys(b.keys)}).`);
  }
  return ok(new Keymap(bindings, leader, timeout));
}
export function defaultKeymap(platform: NodeJS.Platform = process.platform): Keymap {
  const result = parseKeymap({}, platform); if (!result.ok) throw result.error;
  return result.value;
}
export async function loadKeymap(explicitPath?: string): Promise<Result<Keymap, ExpectedError>> {
  const path = explicitPath ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "radian", "keybindings.json");
  const file = await capture(() => readFile(path, "utf8"));
  if (!file.ok) return !explicitPath && file.error instanceof StorageError && file.error.systemCode === "ENOENT" ? ok(defaultKeymap()) : file;
  const parsed = parseJson(file.value, path); if (!parsed.ok) return parsed;
  const keymap = parseKeymap(parsed.value);
  return keymap.ok ? keymap : err(new InputError(`${path}: ${keymap.error.message}`, { cause: keymap.error }));
}
