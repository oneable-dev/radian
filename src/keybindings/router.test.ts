import { expect, test } from "bun:test";
import { InputRenderable, parseKeypress } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { KeyRouter } from "./router.ts";
import { defaultKeymap, parseKeymap, type Keymap } from "./config.ts";
import { expectOk } from "../testing/results.ts";
import { TerminalSurface } from "../ui/embedded-terminal/surface.ts";

async function mount(keymap: Keymap = defaultKeymap()) {
  const clock = new ManualClock(); const app = await createTestRenderer({ width: 60, height: 8, clock, kittyKeyboard: true, exitOnCtrlC: false });
  const a = new InputRenderable(app.renderer, { width: 60 }), b = new InputRenderable(app.renderer, { width: 60 });
  app.renderer.root.add(a); app.renderer.root.add(b); a.focus();
  const commands: string[] = [];
  const router = new KeyRouter(app.renderer, keymap, () => "prompt", (command) => command === "app.detach", (command) => commands.push(command));
  await app.renderOnce();
  return { ...app, a, b, clock, commands, router,
    raw(text: string) { const key = parseKeypress(text, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid test key"); app.renderer.keyInput.processParsedKey(key); },
    async close() { router.dispose(); await app.dispose(); },
  };
}
const printableLeader = () => expectOk(parseKeymap({ leader: "space r", timeoutMs: 200, bindings: { "button.activate": [] } }));

test.each(["\x00", "\x1b[32;5u"])("Legacy/kitty Ctrl+Space then d executes app commands exactly once: %j", async (leader) => {
  const app = await mount();
  try {
    app.raw(leader); app.mockInput.pressKey("d");
    expect(app.commands).toEqual(["app.detach"]); expect(app.a.value).toBe("");
    // Configured-but-unavailable popup commands must not become literal native input.
    app.raw(leader); app.mockInput.pressKey("b"); expect(app.a.value).toBe("");
    app.mockInput.pressCtrlC(); expect(app.commands).toHaveLength(1);
  } finally { await app.close(); }
});

test.each([
  { leader: "ctrl+b", input: ["\x02"] },
  { leader: "space r", input: [" ", "r"] },
])("Leader $leader overrides keep logical hints and physical input mapped to identical commands", async ({ leader, input }) => {
  // Configure Space prefixes without colliding with default button Space bindings.
  const keymap = expectOk(parseKeymap({ leader, bindings: { "button.activate": [] } }));
  const app = await mount(keymap);
  try {
    // Enter logical leaders using their configured physical keys.
    for (const key of input) app.raw(key);
    app.mockInput.pressKey("d");

    // Commands run once and leader input never leaks into drafts.
    expect(keymap.hint("app.detach", "prompt")).toBe("<leader>d");
    expect(app.commands).toEqual(["app.detach"]); expect(app.a.value).toBe("");
  } finally { await app.close(); }
});

test("Mismatches and timeouts restore original literal input once in order", async () => {
  const app = await mount(printableLeader());
  try {
    await app.mockInput.typeText(" rz"); expect(app.a.value).toBe(" rz");
    await app.mockInput.typeText(" r"); expect(app.a.value).toBe(" rz");
    app.clock.advance(199); expect(app.a.value).toBe(" rz");
    app.clock.advance(1); expect(app.a.value).toBe(" rz r"); expect(app.commands).toEqual([]);
  } finally { await app.close(); }
});

test("Pastes never execute app commands even with leader text", async () => {
  const app = await mount(printableLeader());
  try {
    app.mockInput.pressKey(" ");
    await app.mockInput.pasteBracketedText("rc");
    expect(app.a.value).toBe(" rc"); expect(app.commands).toEqual([]);
  } finally { await app.close(); }
});

test("Focus changes during prefixes return buffers only to original input owners", async () => {
  const app = await mount(printableLeader());
  try {
    await app.mockInput.typeText(" r"); app.b.focus(); await app.mockInput.typeText("new"); app.clock.advance(1000);
    expect(app.a.value).toBe(" r"); expect(app.b.value).toBe("new"); expect(app.commands).toEqual([]);
  } finally { await app.close(); }
});

test("Kitty release never duplicates replay or leaks consumed commands to native input", async () => {
  const app = await mount(printableLeader());
  try {
    app.raw("\x1b[32u"); app.raw("\x1b[32;1:3u"); app.mockInput.pressKey("z");
    expect(app.a.value).toBe(" z");
    await app.mockInput.typeText(" rd"); app.raw("\x1b[100;1:3u");
    expect(app.commands).toEqual(["app.detach"]); expect(app.a.value).toBe(" z");
  } finally { await app.close(); }
});

test.each([["search", "search.clear"], ["prompt", "agent.clear"], ["git-prompt", "git.clear"], ["git-search", "git.search-clear"], ["extension-search", "search.clear"]] as const)("%s held Ctrl+C clearing never replays as shell interruption after focus changes", async (context, clearCommand) => {
  // Distinguish clearing started in app inputs from fresh shell interrupts.
  const app = await createTestRenderer({ width: 60, height: 8, kittyKeyboard: true, exitOnCtrlC: false });
  const input = new InputRenderable(app.renderer, { width: 60 }); input.value = "candidate"; app.renderer.root.add(input);
  const surface = new TerminalSurface(app.renderer, "search-clear-terminal"); app.renderer.root.add(surface.root);
  const bytes: string[] = [], commands: string[] = [];
  surface.connect({ input: value => bytes.push(Buffer.from(value).toString("hex")), resize() {}, disconnect: async () => {} });
  input.focus();
  const router = new KeyRouter(app.renderer, defaultKeymap(), () => input.focused ? context : "terminal", command => command === clearCommand,
    command => { commands.push(command); input.value = ""; });
  const raw = (event: string) => { const key = parseKeypress(event, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid Kitty key"); app.renderer.keyInput.processParsedKey(key); };
  try {
    raw("\x1b[99;5u"); surface.root.focus(); raw("\x1b[99;5:2u");

    expect(input.value).toBe(""); expect(commands).toEqual([clearCommand]); expect(bytes).toEqual([]);
    raw("\x1b[99;5:3u"); app.mockInput.pressCtrlC();

    expect(bytes).toContain("03"); expect(commands).toEqual([clearCommand]);
  } finally { router.dispose(); surface.dispose(); await app.dispose(); }
});

test("Held account rename keys never become literal edits after label input takes focus", async () => {
  // The rename command changes focus while its physical key may still be held.
  const app = await createTestRenderer({ width: 60, height: 8, kittyKeyboard: true });
  const input = new InputRenderable(app.renderer, { width: 60 }); app.renderer.root.add(input);
  const commands: string[] = []; let editing = false;
  const router = new KeyRouter(app.renderer, defaultKeymap(), () => editing ? "accounts-input" : "accounts", () => true,
    command => { commands.push(command); editing = true; input.value = "ONEABLE"; input.focus(); });
  const raw = (event: string) => { const key = parseKeypress(event, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid Kitty key"); app.renderer.keyInput.processParsedKey(key); };
  try {
    // Suppress held repeats across the context change, but restore normal typing on release.
    raw("\u001b[114u"); raw("\u001b[114;1:2u");
    expect(input.value).toBe("ONEABLE"); expect(commands).toEqual(["accounts.rename"]);
    raw("\u001b[114;1:3u"); app.mockInput.pressKey("r");

    expect(input.value).toBe("ONEABLEr"); expect(commands).toEqual(["accounts.rename"]);
  } finally { router.dispose(); await app.dispose(); }
});

test("Default Ctrl+C reaches shared native terminals while only leader commands intercept", async () => {
  const app = await createTestRenderer({ width: 60, height: 8, kittyKeyboard: true, exitOnCtrlC: false });
  const surface = new TerminalSurface(app.renderer, "test-terminal"); app.renderer.root.add(surface.root);
  const bytes: string[] = [], commands: string[] = [];
  surface.connect({ input: (value) => bytes.push(Buffer.from(value).toString("hex")), resize: () => {}, disconnect: async () => {} });
  surface.root.focus();
  const router = new KeyRouter(app.renderer, defaultKeymap(), () => "terminal", (command) => command === "app.detach", (command) => commands.push(command));
  try {
    app.mockInput.pressCtrlC(); app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("d");
    expect(bytes).toContain("03"); expect(bytes).not.toContain("00"); expect(commands).toEqual(["app.detach"]);
  } finally { router.dispose(); surface.dispose(); await app.dispose(); }
});
