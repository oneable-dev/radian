import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { capture, InputError, parseJson, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { loadTheme, parseTheme, type ThemeOverrides } from "../ui/theme-config.ts";
import { loadKeymap, parseKeymap, type Keymap } from "../keybindings/config.ts";
import {
  loadWorkspaceConfig,
  parseWorkspaceConfig,
  resolveWorkspaceConfig,
  type WorkspaceConfig,
} from "../workspace/config.ts";
import type { WorkspaceSource } from "../runtime/daemon-protocol.ts";

export type SessionSettings = { readonly retentionDays: number | null };

export type RadianSettings = {
  readonly path: string;
  readonly theme: ThemeOverrides;
  readonly keymap: Keymap;
  readonly workspace: WorkspaceConfig;
  readonly sessions: SessionSettings;
};

type SettingsOptions = {
  config?: string | undefined;
  theme?: string | undefined;
  keybindings?: string | undefined;
  workspaceConfig?: string | undefined;
  includeWorkspace?: boolean;
};

const sections = new Set(["theme", "keybindings", "workspace", "sessions"]);
export const defaultSettingsPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "radian", "settings.json");
const defaultWorkspacePath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "radian", "workspace.json");

/**
 * Builds the minimal workspace reference that the shared daemon remembers.
 *
 * Default locations are captured now so a later restart from another environment still
 * reads the same files. Only references and the launch context are kept; the daemon reads
 * the latest file contents whenever it discovers membership.
 */
export function workspaceSource(options: {
  config?: string | undefined;
  workspaceConfig?: string | undefined;
  cwd: string;
}): WorkspaceSource {
  return {
    settings: {
      path: resolve(options.config ?? defaultSettingsPath()),
      explicit: !!options.config,
    },
    workspace: {
      path: resolve(options.workspaceConfig ?? defaultWorkspacePath()),
      explicit: !!options.workspaceConfig,
    },
    cwd: resolve(options.cwd),
  };
}

/**
 * Reads the current workspace configuration selected by a remembered source.
 *
 * It applies the same precedence as `loadSettings`: an explicit workspace file, then the
 * unified `workspace` section, then the legacy workspace file. Explicitly selected files must
 * exist; implicit defaults may be absent. Offline mode never reads implicit workspace
 * locations, so isolated test daemons cannot scan a user's real roots. Only the settings
 * document is parsed here; theme and keymap sections are neither validated nor initialized.
 */
export async function loadWorkspaceSource(
  source: WorkspaceSource,
  options: { offline: boolean },
): Promise<Result<WorkspaceConfig, ExpectedError>> {
  if (source.workspace.explicit) {
    return loadWorkspaceConfig(source.workspace.path);
  }
  if (options.offline && !source.settings.explicit) {
    return ok({ roots: [], maxDepth: 0 });
  }

  const loaded = await document(
    source.settings.explicit ? source.settings.path : undefined,
    source.settings.path,
  );
  if (!loaded.ok) {
    return loaded;
  }
  if (Object.hasOwn(loaded.value.data, "workspace")) {
    const parsed = parseWorkspaceConfig(loaded.value.data.workspace);

    return parsed.ok
      ? ok(resolveWorkspaceConfig(parsed.value, loaded.value.path))
      : err(
          new InputError(`${loaded.value.path}: ${parsed.error.message}`, { cause: parsed.error }),
        );
  }
  if (options.offline) {
    return ok({ roots: [], maxDepth: 0 });
  }

  return loadImplicitWorkspace(source.workspace.path);
}

// The remembered default workspace file keeps the implicit-missing contract of loadWorkspaceConfig.
async function loadImplicitWorkspace(
  path: string,
): Promise<Result<WorkspaceConfig, ExpectedError>> {
  const read = await capture(() => readFile(path, "utf8"));
  if (!read.ok) {
    return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
      ? ok(resolveWorkspaceConfig(expectDefaults(), path))
      : read;
  }

  const json = parseJson(read.value, path);
  if (!json.ok) {
    return json;
  }

  const parsed = parseWorkspaceConfig(json.value);

  return parsed.ok
    ? ok(resolveWorkspaceConfig(parsed.value, path))
    : err(new InputError(`${path}: ${parsed.error.message}`, { cause: parsed.error }));
}

function expectDefaults(): WorkspaceConfig {
  const defaults = parseWorkspaceConfig({});
  if (!defaults.ok) {
    throw defaults.error;
  }

  return defaults.value;
}

export function parseSessionSettings(value: unknown): Result<SessionSettings, InputError> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "retentionDays")
  ) {
    return err(new InputError("sessions supports retentionDays only."));
  }

  const days = "retentionDays" in value ? value.retentionDays : 30;

  return days === null || (typeof days === "number" && Number.isSafeInteger(days) && days >= 1)
    ? ok({ retentionDays: days })
    : err(
        new InputError(
          "sessions.retentionDays must be a positive integer or null for unlimited retention.",
        ),
      );
}

async function document(
  config?: string,
  implicitPath?: string,
): Promise<
  Result<{ path: string; exists: boolean; data: Record<string, unknown> }, ExpectedError>
> {
  const path = resolve(config ?? implicitPath ?? defaultSettingsPath());
  const read = await capture(() => readFile(path, "utf8"));
  if (!read.ok) {
    return !config && read.error instanceof StorageError && read.error.systemCode === "ENOENT"
      ? ok({ path, exists: false, data: {} })
      : read;
  }

  const json = parseJson(read.value, path);
  if (!json.ok) {
    return json;
  }

  const data = json.value;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some((key) => !sections.has(key))
  ) {
    return err(
      new InputError(`${path}: expected theme, keybindings, workspace and/or sessions sections.`),
    );
  }

  return ok({ path, exists: true, data: data as Record<string, unknown> });
}

// Runtime policies deliberately do not load UI-specific legacy files or initialize native UI/SDK code.
export async function loadSessionSettings(
  config?: string,
  implicitPath?: string,
): Promise<Result<SessionSettings & { path: string; exists: boolean }, ExpectedError>> {
  const loaded = await document(config, implicitPath);
  if (!loaded.ok) {
    return loaded;
  }

  const parsed = parseSessionSettings(
    Object.hasOwn(loaded.value.data, "sessions") ? loaded.value.data.sessions : {},
  );

  return parsed.ok
    ? ok({ ...parsed.value, path: loaded.value.path, exists: loaded.value.exists })
    : err(new InputError(`${loaded.value.path}: ${parsed.error.message}`, { cause: parsed.error }));
}

export async function loadSettings(
  options: SettingsOptions = {},
): Promise<Result<RadianSettings, ExpectedError>> {
  const loaded = await document(options.config);
  if (!loaded.ok) {
    return loaded;
  }

  const { data, path } = loaded.value;
  // Explicit per-section CLI files win; unified sections win over the corresponding optional legacy file.
  const theme =
    options.theme || !Object.hasOwn(data, "theme")
      ? await loadTheme(options.theme)
      : parseTheme(data.theme);
  if (!theme.ok) {
    return theme;
  }

  const keymap =
    options.keybindings || !Object.hasOwn(data, "keybindings")
      ? await loadKeymap(options.keybindings)
      : parseKeymap(data.keybindings);
  if (!keymap.ok) {
    return keymap;
  }

  const workspace =
    options.includeWorkspace === false
      ? parseWorkspaceConfig({ roots: [], maxDepth: 0 })
      : options.workspaceConfig || !Object.hasOwn(data, "workspace")
        ? await loadWorkspaceConfig(options.workspaceConfig)
        : parseWorkspaceConfig(data.workspace);
  if (!workspace.ok) {
    return workspace;
  }

  const sessions = parseSessionSettings(Object.hasOwn(data, "sessions") ? data.sessions : {});
  if (!sessions.ok) {
    return sessions;
  }

  const resolvedWorkspace =
    options.includeWorkspace !== false &&
    !options.workspaceConfig &&
    Object.hasOwn(data, "workspace")
      ? resolveWorkspaceConfig(workspace.value, path)
      : workspace.value;

  return ok({
    path,
    theme: theme.value,
    keymap: keymap.value,
    workspace: resolvedWorkspace,
    sessions: sessions.value,
  });
}
