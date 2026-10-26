import { expect, test } from "bun:test";
import { PtySession } from "./session.ts";
import { expectOk } from "../../testing/results.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Fixture PTY output timed out."); await Bun.sleep(5); }
}
async function mount(waitForResizeOutput: boolean) {
  const ready = Promise.withResolvers<void>();
  // The child acknowledges startup but deliberately redraws only when instructed over owned IPC.
  const script = `process.on("SIGWINCH", () => {});
    process.on("message", (message) => {
      if (message && message.type === "paint") process.stdout.write("\\x1bcNEW-OUTPUT");
    });
    process.stdout.write("\\x1bcOLD-OUTPUT"); process.send("ready"); setInterval(() => {}, 1000);`;
  const session = new PtySession("fixture", { argv: [process.execPath, "-e", script], cwd: process.cwd(),
    size: { cols: 20, rows: 2 }, waitForResizeOutput, ipc: (message) => { if (message === "ready") ready.resolve(); } }, () => {});
  await ready.promise; await until(() => session.frame().ansi.includes("OLD-OUTPUT"));
  const stream = expectOk(session.attach("fixture-lease")).body!;
  const reader = stream.getReader(); await reader.read();
  return { session, async close() { await reader.cancel(); expectOk(await session.dispose()); } };
}

test("Editor PTY resize acceptance never publishes dimension-changed incomplete screens", async () => {
  const app = await mount(true);
  try {
    const before = app.session.frame();
    await app.session.resize(40, 2, "fixture-lease");

    // A resize acknowledgement is not evidence that the application has redrawn its screen.
    expect(app.session.frame()).toEqual(before);
    app.session.process.send({ type: "paint" });
    await until(() => app.session.frame().cols === 40 && app.session.frame().ansi.includes("NEW-OUTPUT"));
    expect(app.session.frame().revision).toBeGreaterThan(before.revision);
  } finally { await app.close(); }
});

test("Consecutive resizes retain initial screens until actual output at final dimensions arrives", async () => {
  const app = await mount(true);
  try {
    const before = app.session.frame();
    await app.session.resize(40, 2, "fixture-lease"); await app.session.resize(60, 2, "fixture-lease");
    expect(app.session.frame()).toEqual(before);
    app.session.process.send({ type: "paint" });
    await until(() => app.session.frame().cols === 60 && app.session.frame().ansi.includes("NEW-OUTPUT"));
    expect(app.session.frame().revision).toBeGreaterThan(before.revision);
  } finally { await app.close(); }
});

test("Exit while awaiting repaint publishes final state despite retained old screens", async () => {
  const app = await mount(true);
  try {
    await app.session.resize(40, 2, "fixture-lease");
    app.session.finish(0);
    expect(app.session.frame().exited).toBe(true); expect(app.session.frame().exitCode).toBe(0);
  } finally { await app.close(); }
});

test("Output reads validate lease ownership and isolate snapshots from later output", async () => {
  // Reading enforces the same connection ownership checks as writing.
  const app = await mount(false);
  try {
    const rejected = await app.session.read("stale-lease");
    expect(rejected.ok).toBe(false); if (!rejected.ok) expect(rejected.error.code).toBe("PTY_BUSY");
    const before = app.session.frame(), snapshot = expectOk(await app.session.read("fixture-lease"));
    expect(snapshot.text).toContain("OLD-OUTPUT"); expect(app.session.frame()).toEqual(before);

    app.session.process.send({ type: "paint" });
    await until(() => app.session.frame().ansi.includes("NEW-OUTPUT"));

    expect(snapshot.text).not.toContain("NEW-OUTPUT");
    expect(expectOk(await app.session.read("fixture-lease")).text).toContain("NEW-OUTPUT");
  } finally { await app.close(); }
});

test("PTY frames publish complete wrapped link targets with visible cell ranges", async () => {
  // A real process supplies output; link metadata must accompany its ANSI snapshot.
  const url = "http://localhost:3000/preview";
  const session = new PtySession("fixture", { argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(url)}); setInterval(() => {}, 1000);`],
    cwd: process.cwd(), size: { cols: 20, rows: 2 } }, () => {});
  try {
    // Wait for the VT parser rather than assuming that process startup has painted output.
    await until(() => !!session.frame().links?.length);

    // One target covers both physical rows without duplicating the wrapped URL.
    expect(session.frame().links).toEqual([{ url, cells: [{ row: 0, start: 0, end: 20 }, { row: 1, start: 0, end: 9 }] }]);
  } finally { expectOk(await session.dispose()); }
});

test("Ordinary shell PTYs preserve immediate resize behavior without awaiting repaint", async () => {
  const app = await mount(false);
  try {
    await app.session.resize(40, 2, "fixture-lease");
    expect(app.session.frame().cols).toBe(40); expect(app.session.frame().ansi).toContain("OLD-OUTPUT");
  } finally { await app.close(); }
});
