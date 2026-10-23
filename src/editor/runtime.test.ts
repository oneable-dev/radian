import { expect, test } from "bun:test";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { EditorSessions } from "./sessions.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "../runtime/client.ts";
import { parseCommand, type EditorFrame } from "../runtime/protocol.ts";
import { pidAlive } from "../runtime/storage.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Editor observation timed out.");
    await Bun.sleep(20);
  }
}
async function screen(frame: EditorFrame) {
  const terminal = new Terminal({ cols: frame.cols, rows: frame.rows, scrollback: 0, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write(frame.ansi, resolve));
    return { text: terminal.buffer.active.getLine(0)?.translateToString(true),
      x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY };
  } finally { terminal.dispose(); }
}
async function watch(client: RuntimeClient, id: string) {
  let frame: EditorFrame | undefined;
  const errors: unknown[] = [];
  const connection = expectOk(await client.attachEditor(id, (value) => { frame = value; }, (error) => errors.push(error)));
  return { connection, errors, get frame() { if (!frame) throw new Error("Missing first frame"); return frame; },
    async text(value: string) { await until(() => frame?.ansi.includes(value) ?? false); } };
}
async function setup() {
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "index.ts") };
  const clients: RuntimeClient[] = [];
  return { ...fixture, options,
    async connect() {
      const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
      if (!client) throw new Error("Missing runtime"); clients.push(client); return client;
    },
    async cleanup() {
      await Promise.all(clients.map((client) => client.disconnect()));
      const admin = expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
      if (admin) {
        const pids = admin.snapshot.editors?.map((editor) => editor.pid) ?? [];
        expectOk(await admin.stopRuntime()); await admin.disconnect();
        await until(async () => !expectOk(await fetchSnapshot(admin.paths)) && pids.every((pid) => !pidAlive(pid)));
      }
      await fixture.cleanup();
    },
  };
}

test("Real per-worktree Neovim buffers and cursors survive TUI reconnects with identical PIDs", async () => {
  // Separate worktrees and a clean Neovim avoid touching user files/configuration.
  const app = await setup();
  try {
    const client = await app.connect();
    const a = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const b = app.repository.worktrees.find((tree) => tree.path === app.feature)!;
    const aid = expectOk(await client.openEditor(a.id));
    const bid = expectOk(await client.openEditor(b.id));
    const first = await watch(client, aid), second = await watch(client, bid);
    await first.text("NVIM"); await second.text("NVIM");
    first.connection.input(new TextEncoder().encode(":edit workspace.txt\riunsaved-A\x1b"));
    second.connection.input(new TextEncoder().encode(":edit workspace.txt\riunsaved-B\x1b"));
    await first.text("unsaved-Amain-worktree-marker"); await second.text("unsaved-Bfeature-worktree-marker");
    first.connection.resize(93, 19); await until(() => first.frame.cols === 93 && first.frame.rows === 19);
    // Verify the actual Neovim dimensions, not only the service's VT metadata.
    first.connection.input(new TextEncoder().encode(":call writefile([printf('%dx%d', &columns, &lines)], 'editor-size.txt')\r"));
    await until(() => Bun.file(join(app.main, "editor-size.txt")).exists());
    expect(await Bun.file(join(app.main, "editor-size.txt")).text()).toBe("93x19\n");
    const before = await screen(first.frame), pid = first.frame.pid;
    const preferences = { ...client.snapshot.preferences, workViews: { active: { [a.id]: "editor" as const, [b.id]: "git" as const }, agentScroll: { saved: 7 } } };
    expectOk(await client.savePreferences(preferences));

    // Disconnect all UI streams without terminating either editor or saving the modified buffers.
    await client.disconnect();
    expect(pidAlive(pid)).toBe(true);
    const reconnected = await app.connect();
    const restored = await watch(reconnected, aid);

    // A fresh VT screen reconstructs the same content/cursor, not just an old tab name.
    expect(restored.frame.pid).toBe(pid);
    expect(await screen(restored.frame)).toEqual(before);
    expect(reconnected.snapshot.preferences.workViews).toEqual(preferences.workViews);
    expect(await Bun.file(join(app.main, "workspace.txt")).text()).toBe("main-worktree-marker\n");
    expect(await Bun.file(join(app.feature, "workspace.txt")).text()).toBe("feature-worktree-marker\n");
    expect(first.errors).toEqual([]); expect(second.errors).toEqual([]); expect(restored.errors).toEqual([]);
  } finally { await app.cleanup(); }
}, 20000);

test("Editor input belongs only to current attachments, never old leases or other worktrees", async () => {
  // One daemon editor may be observed/reconnected, but concurrent writers cannot steal it.
  const app = await setup();
  try {
    const client = await app.connect(), other = await app.connect();
    const id = expectOk(await client.openEditor(app.repository.worktrees[0]!.id));
    const initial = await watch(client, id); await initial.text("NVIM");
    expect(expectError(await other.attachEditor(id, () => {}, () => {})).code).toBe("EDITOR_BUSY");
    const oldLease = initial.connection.lease;
    await initial.connection.disconnect();
    const next = await watch(other, id);

    // A delayed request from the detached UI cannot mutate the new attachment.
    const reply = await fetch("http://localhost/command", { unix: client.paths.socket, method: "POST", body: JSON.stringify({
      type: "editor-input", editorId: id, lease: oldLease, data: Buffer.from("iLOST").toString("base64"),
    }) });
    expect(reply.status).toBe(409);
    next.connection.input(new TextEncoder().encode("ikept\x1b")); await next.text("kept");
    expect((await screen(next.frame)).text).toBe("kept");
  } finally { await app.cleanup(); }
}, 15000);

test("Neovim exit disables auto-restart and coalesces explicit reopen requests", async () => {
  // Exiting Neovim is distinct from hiding its view or detaching the TUI.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees[0]!;
    const id = expectOk(await client.openEditor(tree.id));
    const editor = await watch(client, id); await editor.text("NVIM");
    editor.connection.input(new TextEncoder().encode(":qa!\r"));
    await until(() => editor.frame.exited);
    const pid = editor.frame.pid;
    await editor.connection.disconnect();

    // Concurrent explicit opens return one fresh process, while old IDs remain invalid.
    const [a, b] = await Promise.all([client.openEditor(tree.id), client.openEditor(tree.id)]);
    expect(expectOk(a)).toBe(expectOk(b)); expect(expectOk(a)).not.toBe(id);
    expect(pidAlive(pid)).toBe(false);
    expect(expectError(await client.attachEditor(id, () => {}, () => {})).code).toBe("EDITOR_NOT_OPEN");
  } finally { await app.cleanup(); }
}, 15000);

test("Unknown worktrees and missing executables fail predictably without processes", async () => {
  const app = await createWorktreeFixture();
  const editors = new EditorSessions([app.repository], () => {}, { executable: "radian-nonexistent-editor" });
  try {
    // Validate scope and executable before allocating a PTY/Neovim process.
    expect(expectError(await editors.open("unknown")).code).toBe("INVALID_INPUT");
    expect(expectError(await editors.open(app.repository.worktrees[0]!.id)).code).toBe("EDITOR_UNAVAILABLE");
    expect(editors.infos).toEqual([]);
  } finally { expectOk(await editors.stop()); await app.cleanup(); }
});

test("Editor contracts reject invalid bytes/sizes and retain preference compatibility", () => {
  // Existing clients/manifests do not have workViews; all new fields are additive.
  expectOk(parseCommand(JSON.stringify({ type: "preferences", preferences: { selection: { worktreeId: null, sessions: {} }, drafts: {} } })));
  expect(expectError(parseCommand(JSON.stringify({ type: "editor-input", editorId: "a", lease: "b", data: "not base64!" }))).code).toBe("INVALID_INPUT");
  for (const cols of [0, 501, 4.5]) expect(expectError(parseCommand(JSON.stringify({ type: "editor-resize", editorId: "a", lease: "b", cols, rows: 24 }))).code).toBe("INVALID_INPUT");
});

test("Long-idle editing preserves main and Editor IPC connections", async () => {
  // This exceeds Bun's real default HTTP idle timeout, unlike a mocked stream test.
  const app = await setup();
  try {
    const client = await app.connect(), id = expectOk(await client.openEditor(app.repository.worktrees[0]!.id));
    const editor = await watch(client, id); await editor.text("NVIM");
    await Bun.sleep(16000);

    editor.connection.input(new TextEncoder().encode("iafter-idle\x1b")); await editor.text("after-idle");
    expectOk(await client.savePreferences(client.snapshot.preferences));
    expect(editor.errors).toEqual([]);
  } finally { await app.cleanup(); }
}, 25000);
