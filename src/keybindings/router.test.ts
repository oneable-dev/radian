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

test.each(["\x00", "\x1b[32;5u"])("legacy/kitty Ctrl+Space 다음 c는 앱 명령으로 한 번 실행한다: %j", async (leader) => {
  const app = await mount();
  try {
    app.raw(leader); app.mockInput.pressKey("c");
    expect(app.commands).toEqual(["app.detach"]); expect(app.a.value).toBe("");
    // Configured-but-unavailable focus commands must not become literal native input.
    app.raw(leader); app.mockInput.pressKey("f"); expect(app.a.value).toBe("");
    app.mockInput.pressCtrlC(); expect(app.commands).toHaveLength(1);
  } finally { await app.close(); }
});

test("불일치와 timeout은 원래 문자 입력을 순서대로 한 번 복원한다", async () => {
  const app = await mount(printableLeader());
  try {
    await app.mockInput.typeText(" rz"); expect(app.a.value).toBe(" rz");
    await app.mockInput.typeText(" r"); expect(app.a.value).toBe(" rz");
    app.clock.advance(199); expect(app.a.value).toBe(" rz");
    app.clock.advance(1); expect(app.a.value).toBe(" rz r"); expect(app.commands).toEqual([]);
  } finally { await app.close(); }
});

test("붙여넣기는 leader 문자열을 포함해도 앱 명령을 실행하지 않는다", async () => {
  const app = await mount(printableLeader());
  try {
    app.mockInput.pressKey(" ");
    await app.mockInput.pasteBracketedText("rc");
    expect(app.a.value).toBe(" rc"); expect(app.commands).toEqual([]);
  } finally { await app.close(); }
});

test("prefix 도중 포커스 변경은 이전 입력 대상에만 버퍼를 반환한다", async () => {
  const app = await mount(printableLeader());
  try {
    await app.mockInput.typeText(" r"); app.b.focus(); await app.mockInput.typeText("new"); app.clock.advance(1000);
    expect(app.a.value).toBe(" r"); expect(app.b.value).toBe("new"); expect(app.commands).toEqual([]);
  } finally { await app.close(); }
});

test("kitty release는 문자 재생을 중복하지 않고 명령 소비 후 native로 누출되지 않는다", async () => {
  const app = await mount(printableLeader());
  try {
    app.raw("\x1b[32u"); app.raw("\x1b[32;1:3u"); app.mockInput.pressKey("z");
    expect(app.a.value).toBe(" z");
    await app.mockInput.typeText(" rc"); app.raw("\x1b[99;1:3u");
    expect(app.commands).toEqual(["app.detach"]); expect(app.a.value).toBe(" z");
  } finally { await app.close(); }
});

test.each([["search", "search.clear"], ["prompt", "agent.clear"], ["git-prompt", "git.clear"]] as const)("%s 입력 지우기의 held Ctrl+C는 포커스 이동 뒤 쉘 인터럽트로 재생되지 않는다", async (context, clearCommand) => {
  // 앱 입력에서 시작한 지우기와 나중에 쉘에서 새로 누른 인터럽트를 구분한다.
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

test("기본 Ctrl+C는 공통 native terminal에 전달하고 leader 명령만 가로챈다", async () => {
  const app = await createTestRenderer({ width: 60, height: 8, kittyKeyboard: true, exitOnCtrlC: false });
  const surface = new TerminalSurface(app.renderer, "test-terminal"); app.renderer.root.add(surface.root);
  const bytes: string[] = [], commands: string[] = [];
  surface.connect({ input: (value) => bytes.push(Buffer.from(value).toString("hex")), resize: () => {}, disconnect: async () => {} });
  surface.root.focus();
  const router = new KeyRouter(app.renderer, defaultKeymap(), () => "terminal", (command) => command === "app.detach", (command) => commands.push(command));
  try {
    app.mockInput.pressCtrlC(); app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("c");
    expect(bytes).toContain("03"); expect(bytes).not.toContain("00"); expect(commands).toEqual(["app.detach"]);
  } finally { router.dispose(); surface.dispose(); await app.dispose(); }
});
