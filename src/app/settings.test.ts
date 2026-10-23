import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectError, expectOk } from "../testing/results.ts";
import { loadSessionSettings, loadSettings, parseSessionSettings } from "./settings.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-settings-")), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  const root = join(directory, "radian"); await mkdir(root);
  return { directory, root, settings: join(root, "settings.json"),
    async file(name: string, data: unknown) { const path = join(root, name); await writeFile(path, JSON.stringify(data)); return path; },
    async close() { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; await rm(directory, { recursive: true, force: true }); } };
}

test("Unified settings validate each section and resolve workspace paths relative to config files", async () => {
  // Unified sections override corrupt legacy files for the same scope.
  const app = await fixture();
  try {
    await app.file("theme.json", { invalid: true }); await app.file("keybindings.json", { invalid: true }); await app.file("workspace.json", { invalid: true });
    await app.file("settings.json", { theme: { accent: "#123456", styles: { "status.success": { bold: true } } }, keybindings: { leader: "ctrl+b" }, workspace: { roots: ["./repos"], maxDepth: 2 }, sessions: { retentionDays: 7 } });

    // Read all Radian settings from one real external file.
    const settings = expectOk(await loadSettings());

    // UI, discovery, and runtime policies share format while preserving domain behavior.
    expect(settings.path).toBe(app.settings); expect(settings.theme.accent).toBe("#123456");
    expect(settings.keymap.leader).toEqual(["ctrl+b"]);
    expect(settings.keymap.hint("app.detach", "none")).toBe("<leader>d");
    expect(settings.workspace).toEqual({ roots: [join(app.root, "repos")], maxDepth: 2 }); expect(settings.sessions.retentionDays).toBe(7);
  } finally { await app.close(); }
});

test("Explicit file options override unified settings and legacy files fill only missing sections", async () => {
  // Select themes through CLI while retaining legacy bindings and discovery paths.
  const app = await fixture();
  try {
    await app.file("settings.json", { theme: { accent: "#111111" }, sessions: { retentionDays: null } });
    const theme = await app.file("custom-theme.json", { accent: "#ABCDEF" });
    await app.file("keybindings.json", { leader: "ctrl+b" }); await app.file("workspace.json", { roots: ["./legacy"] });

    // Precedence: explicit options, unified sections, legacy files, then defaults.
    const settings = expectOk(await loadSettings({ theme }));

    // Unified settings must not silently discard existing user settings.
    expect(settings.theme.accent).toBe("#ABCDEF"); expect(settings.keymap.leader).toEqual(["ctrl+b"]);
    expect(settings.keymap.hint("app.detach", "none")).toBe("<leader>d");
    expect(settings.workspace.roots).toEqual([join(app.root, "legacy")]); expect(settings.sessions.retentionDays).toBeNull();
  } finally { await app.close(); }
});

test("Absent default config uses 30 days while missing or corrupt explicit files fail", async () => {
  // Default config is optional; files supplied with --config are required.
  const app = await fixture();
  try {
    expect(expectOk(await loadSettings()).sessions.retentionDays).toBe(30);

    // Replacing invalid files with 30-day retention could delete history unexpectedly.
    const missing = expectError(await loadSettings({ config: join(app.root, "missing.json") }));
    await writeFile(app.settings, "{broken JSON"); const broken = expectError(await loadSessionSettings());

    // Runtime also reports file errors instead of interpreting cleanup policy.
    expect(missing.code).toBe("STORAGE_FAILED"); expect(broken.code).toBe("INVALID_INPUT");
  } finally { await app.close(); }
});

test.each([null, [], { unknown: 30 }, { retentionDays: 0 }, { retentionDays: -1 }, { retentionDays: 1.5 }, { retentionDays: "30" }, { retentionDays: undefined }].map(value => ({ value })))("Invalid retention setting %j never falls back to automatic cleanup defaults", ({ value }) => {
  // Treating invalid values as valid policy could delete history unintentionally.
  const result = parseSessionSettings(value);

  // Never infer unlimited retention from zero or strings.
  expect(expectError(result).code).toBe("INVALID_INPUT");
});

test("Runtime reads only retention policy without depending on UI settings or files", async () => {
  // Invalid themes or bindings must not affect history cleanup in running daemons.
  const app = await fixture();
  try {
    await app.file("settings.json", { theme: "UI-invalid", keybindings: 123, sessions: { retentionDays: 90 } });
    await app.file("theme.json", { invalid: true });

    // Session policy neither initializes UI nor reads legacy UI settings.
    const sessions = expectOk(await loadSessionSettings());
    const ui = expectError(await loadSettings());

    // UI and runtime responsibilities remain separate despite a shared file.
    expect(sessions.retentionDays).toBe(90); expect(ui.code).toBe("INVALID_INPUT");
  } finally { await app.close(); }
});

test("Invalid unified roots or sessions values stop runtime cleanup", async () => {
  // Null means unlimited only for retentionDays, not the whole sessions section.
  const app = await fixture();
  try {
    for (const data of [{ unknown: {} }, { sessions: null }, []]) {
      await app.file("settings.json", data);

      // Validate policy format on every reload.
      const result = await loadSessionSettings();

      // Never silently ignore corruption or unknown settings.
      expect(expectError(result).code).toBe("INVALID_INPUT");
    }
  } finally { await app.close(); }
});

test("Display-only modes skip unused legacy workspace files", async () => {
  // Preserve discovery-free behavior for --demo and --test-runtime.
  const app = await fixture();
  try {
    await writeFile(join(app.root, "workspace.json"), "invalid JSON");

    // Read UI settings but skip actual repository discovery configuration.
    const settings = expectOk(await loadSettings({ includeWorkspace: false }));

    // Corrupt unused files must not fail demos or isolated tests.
    expect(settings.workspace).toEqual({ roots: [], maxDepth: 0 });
  } finally { await app.close(); }
});
