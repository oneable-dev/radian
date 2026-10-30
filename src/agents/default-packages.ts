import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DefaultPackageManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { ResourceError, systemCode } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const defaultPackageNames = ["pi-mcp-adapter", "pi-web-access"] as const;

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
type PackageSource = NonNullable<Settings["packages"]>[number];
type Scope = "user" | "project";

type Options = {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  defaultPackagePaths: readonly string[];
  additionalExtensionPaths?: readonly string[];
};

/** Package identities follow real paths, including Nix-managed and npm-linked installations. */
export function packageIdentity(path: string): Result<string | undefined, ResourceError> {
  try {
    let directory = realpathSync(path);
    if (!statSync(directory).isDirectory()) directory = dirname(directory);
    for (;;) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (
          value &&
          typeof value === "object" &&
          "name" in value &&
          typeof value.name === "string"
        ) {
          return ok(value.name);
        }
      }
      const parent = dirname(directory);
      if (parent === directory) return ok(undefined);
      directory = parent;
    }
  } catch (cause) {
    const code = systemCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return ok(undefined);
    if (code || cause instanceof SyntaxError) {
      return err(new ResourceError(`Cannot identify extension package at ${path}.`, { cause }));
    }
    throw cause;
  }
}

export function defaultPackagePaths(): string[] {
  return defaultPackageNames.map((name) => {
    if (Bun.isStandaloneExecutable) {
      const root = join(dirname(process.execPath), "packages", "node_modules", name);
      const identity = packageIdentity(root);
      if (!identity.ok) throw identity.error;
      if (identity.value !== name)
        throw new ResourceError(
          `Default extension package ${name} is missing from this distribution.`,
        );
      return realpathSync(root);
    }
    let directory = dirname(Bun.resolveSync(name, import.meta.dir));
    for (;;) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (value && typeof value === "object" && "name" in value && value.name === name) {
          return directory;
        }
      }
      const parent = dirname(directory);
      if (parent === directory)
        throw new ResourceError(`Default extension package ${name} is unavailable.`);
      directory = parent;
    }
  });
}

function extensionPath(directory: string, entry: string): string {
  const path = entry.replace(/^[+!-]/u, "");
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(directory, path);
}

function extensionIdentities(directory: string, configured: readonly string[]): string[] {
  const candidates = configured.map((entry) => extensionPath(directory, entry));
  try {
    candidates.push(
      ...readdirSync(join(directory, "extensions")).map((entry) =>
        join(directory, "extensions", entry),
      ),
    );
  } catch (cause) {
    const code = systemCode(cause);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      if (!code) throw cause;
      throw new ResourceError(`Cannot discover configured extensions at ${directory}.`, { cause });
    }
  }
  return candidates.flatMap((path) => {
    const identity = packageIdentity(path);
    if (!identity.ok) throw identity.error;
    return identity.value ? [identity.value] : [];
  });
}

/** A read-only SDK view: package defaults never become persisted user settings. */
export function defaultPackageSettings(options: Options): SettingsManager {
  const settings = options.settingsManager;
  const manager = new DefaultPackageManager(options);
  const identity = (source: PackageSource, scope: Scope) => {
    const value = typeof source === "string" ? source : source.source;
    // A missing or incompatible explicit npm installation still owns its name. Never
    // silently replace that selection with the bundled copy after a discovery error.
    if (value.startsWith("npm:")) return /^npm:((?:@[^/]+\/)?[^@]+)/u.exec(value)?.[1];
    const path = manager.getInstalledPath(value, scope);
    if (!path) return undefined;
    const result = packageIdentity(path);
    // Settings access is an exception-based SDK boundary.
    if (!result.ok) throw result.error;
    return result.value;
  };
  const defaults = options.defaultPackagePaths.map((path) => {
    const result = packageIdentity(path);
    if (!result.ok) throw result.error;
    if (!result.value)
      throw new ResourceError(`Default extension package has no identity: ${path}.`);
    return { path, name: result.value };
  });

  const view = () => {
    const global = settings.getGlobalSettings();
    const project = settings.getProjectSettings();
    const projectNames = new Set<string>();
    const selected = new Set<string>([
      ...extensionIdentities(options.agentDir, global.extensions ?? []),
      ...(settings.isProjectTrusted()
        ? extensionIdentities(join(options.cwd, ".pi"), project.extensions ?? [])
        : []),
    ]);
    for (const source of options.additionalExtensionPaths ?? []) {
      if (source.startsWith("builtin:")) continue;
      if (source.startsWith("npm:")) {
        const name = /^npm:((?:@[^/]+\/)?[^@]+)/u.exec(source)?.[1];
        if (name) selected.add(name);
      } else {
        const identity = packageIdentity(extensionPath(options.cwd, source));
        if (!identity.ok) throw identity.error;
        if (identity.value) selected.add(identity.value);
      }
    }
    const dedupe = (sources: PackageSource[], scope: Scope) => {
      const seen = new Set<string>();
      return sources.filter((source) => {
        const name = identity(source, scope);
        if (!name) return true;
        if (seen.has(name)) return false;
        seen.add(name);
        selected.add(name);
        if (scope === "project" && !(typeof source === "object" && source.autoload === false)) {
          projectNames.add(name);
        }
        if (
          typeof source === "object" &&
          source.autoload !== false &&
          (["extensions", "skills", "prompts", "themes"] as const).every(
            (type) => Array.isArray(source[type]) && source[type]!.length === 0,
          )
        ) {
          return false; // An entirely disabled package needs neither import nor installation.
        }
        return scope !== "user" || !projectNames.has(name);
      });
    };
    const projectPackages = dedupe(project.packages ?? [], "project");
    const globalPackages = dedupe(global.packages ?? [], "user");
    return {
      global: {
        ...global,
        packages: [
          ...globalPackages,
          ...defaults.filter((entry) => !selected.has(entry.name)).map((entry) => entry.path),
        ],
      },
      project: { ...project, packages: projectPackages },
    };
  };

  // Keep trust changes, reloads and model settings on the original manager. Only the
  // two package-discovery snapshots differ; binding preserves the SDK's receiver.
  return new Proxy(settings, {
    get(target, key) {
      if (key === "getGlobalSettings") return () => view().global;
      if (key === "getProjectSettings") return () => view().project;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
