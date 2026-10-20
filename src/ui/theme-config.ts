import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { capture, InputError, parseJson, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { isStyleGroup, type StyleOverride, type StyleOverrides } from "./theme-style-config.ts";

export const themeRoles = ["text", "panel", "surface", "muted", "selected", "accent", "success", "error", "warning", "attention", "info", "keyword", "number", "added", "removed"] as const;
export type ThemeRole = typeof themeRoles[number];
export type ThemeOverrides = Partial<Record<ThemeRole, string>> & { styles?: StyleOverrides };
export const isThemeColor = (value: unknown): value is string => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

export function parseTheme(value: unknown): Result<ThemeOverrides, InputError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err(new InputError("Invalid theme: expected an object of color overrides."));
  const overrides: ThemeOverrides = {};
  for (const [role, color] of Object.entries(value)) {
    if (role === "styles") {
      const styles = parseStyles(color); if (!styles.ok) return styles;
      overrides.styles = styles.value; continue;
    }
    if (!themeRoles.some((known) => known === role)) return err(new InputError(`Invalid theme: unknown color role ${role}.`));
    if (!isThemeColor(color)) return err(new InputError(`Invalid theme: ${role} must be a #RRGGBB color.`));
    // Role membership and color syntax have both been checked at the file boundary.
    overrides[role as ThemeRole] = color;
  }
  return ok(overrides);
}

function parseStyles(value: unknown): Result<StyleOverrides, InputError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err(new InputError("Invalid theme: styles must be an object."));
  const styles: StyleOverrides = {};
  for (const [group, input] of Object.entries(value)) {
    if (!isStyleGroup(group)) return err(new InputError(`Invalid theme: unknown style group ${group}.`));
    if (typeof input !== "object" || input === null || Array.isArray(input)) return err(new InputError(`Invalid theme: ${group} must be a style object.`));
    const style: StyleOverride = {};
    for (const [key, attribute] of Object.entries(input)) {
      if (key === "fg" || key === "bg") {
        if (key === "bg" && attribute === null) style.bg = null;
        else if (isThemeColor(attribute)) style[key] = attribute;
        else return err(new InputError(`Invalid theme: ${group}.${key} must be a #RRGGBB color${key === "bg" ? " or null" : ""}.`));
      } else if (key === "bold" || key === "italic" || key === "underline") {
        if (typeof attribute !== "boolean") return err(new InputError(`Invalid theme: ${group}.${key} must be a boolean.`));
        style[key] = attribute;
      } else return err(new InputError(`Invalid theme: unknown style attribute ${group}.${key}.`));
    }
    styles[group] = style;
  }
  return ok(styles);
}

export async function loadTheme(explicitPath?: string): Promise<Result<ThemeOverrides, ExpectedError>> {
  const path = explicitPath ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "radian", "theme.json");
  const file = await capture(() => readFile(path, "utf8"));
  if (!file.ok) return !explicitPath && file.error instanceof StorageError && file.error.systemCode === "ENOENT" ? ok({}) : file;
  const parsed = parseJson(file.value, path); if (!parsed.ok) return parsed;
  const theme = parseTheme(parsed.value);
  return theme.ok ? theme : err(new InputError(`${path}: ${theme.error.message}`, { cause: theme.error }));
}
