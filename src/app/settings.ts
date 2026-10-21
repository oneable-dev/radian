import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { capture, InputError, parseJson, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { loadTheme, parseTheme, type ThemeOverrides } from "../ui/theme-config.ts";
import { loadKeymap, parseKeymap, type Keymap } from "../keybindings/config.ts";
import { loadWorkspaceConfig, parseWorkspaceConfig, resolveWorkspaceConfig, type WorkspaceConfig } from "../workspace/config.ts";

export type SessionSettings = { readonly retentionDays: number | null };
export type RadianSettings = {
  readonly path: string; readonly theme: ThemeOverrides; readonly keymap: Keymap;
  readonly workspace: WorkspaceConfig; readonly sessions: SessionSettings;
};
type SettingsOptions = { config?: string | undefined; theme?: string | undefined; keybindings?: string | undefined; workspaceConfig?: string | undefined; includeWorkspace?: boolean };
const sections = new Set(["theme", "keybindings", "workspace", "sessions"]);
export const defaultSettingsPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "radian", "settings.json");

export function parseSessionSettings(value: unknown): Result<SessionSettings, InputError> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "retentionDays")) return err(new InputError("sessions supports retentionDays only."));
  const days = "retentionDays" in value ? value.retentionDays : 30;
  return days === null || typeof days === "number" && Number.isSafeInteger(days) && days >= 1
    ? ok({ retentionDays: days }) : err(new InputError("sessions.retentionDays must be a positive integer or null for unlimited retention."));
}

async function document(config?: string): Promise<Result<{ path: string; exists: boolean; data: Record<string, unknown> }, ExpectedError>> {
  const path = resolve(config ?? defaultSettingsPath());
  const read = await capture(() => readFile(path, "utf8"));
  if (!read.ok) return !config && read.error instanceof StorageError && read.error.systemCode === "ENOENT" ? ok({ path, exists: false, data: {} }) : read;
  const json = parseJson(read.value, path); if (!json.ok) return json;
  const data = json.value;
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !sections.has(key))) return err(new InputError(`${path}: expected theme, keybindings, workspace and/or sessions sections.`));
  return ok({ path, exists: true, data: data as Record<string, unknown> });
}

// Runtime policies deliberately do not load UI-specific legacy files or initialize native UI/SDK code.
export async function loadSessionSettings(config?: string): Promise<Result<SessionSettings & { path: string; exists: boolean }, ExpectedError>> {
  const loaded = await document(config); if (!loaded.ok) return loaded;
  const parsed = parseSessionSettings(Object.hasOwn(loaded.value.data, "sessions") ? loaded.value.data.sessions : {});
  return parsed.ok ? ok({ ...parsed.value, path: loaded.value.path, exists: loaded.value.exists })
    : err(new InputError(`${loaded.value.path}: ${parsed.error.message}`, { cause: parsed.error }));
}

export async function loadSettings(options: SettingsOptions = {}): Promise<Result<RadianSettings, ExpectedError>> {
  const loaded = await document(options.config); if (!loaded.ok) return loaded;
  const { data, path } = loaded.value;
  // Explicit per-section CLI files win; unified sections win over the corresponding optional legacy file.
  const theme = options.theme || !Object.hasOwn(data, "theme") ? await loadTheme(options.theme) : parseTheme(data.theme);
  if (!theme.ok) return theme;
  const keymap = options.keybindings || !Object.hasOwn(data, "keybindings") ? await loadKeymap(options.keybindings) : parseKeymap(data.keybindings);
  if (!keymap.ok) return keymap;
  const workspace = options.includeWorkspace === false ? parseWorkspaceConfig({ roots: [], maxDepth: 0 })
    : options.workspaceConfig || !Object.hasOwn(data, "workspace") ? await loadWorkspaceConfig(options.workspaceConfig)
      : parseWorkspaceConfig(data.workspace);
  if (!workspace.ok) return workspace;
  const sessions = parseSessionSettings(Object.hasOwn(data, "sessions") ? data.sessions : {}); if (!sessions.ok) return sessions;
  const resolvedWorkspace = options.includeWorkspace !== false && !options.workspaceConfig && Object.hasOwn(data, "workspace")
    ? resolveWorkspaceConfig(workspace.value, path) : workspace.value;
  return ok({ path, theme: theme.value, keymap: keymap.value, workspace: resolvedWorkspace, sessions: sessions.value });
}
