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

test("Editor용 PTY는 리사이즈 수락만으로 치수가 바뀐 미완성 화면을 게시하지 않는다", async () => {
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

test("연속 리사이즈도 최초 화면을 유지하다 마지막 치수의 실제 출력으로 교체한다", async () => {
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

test("재출력 대기 중 종료도 이전 실행 화면에 가려지지 않고 최종 상태로 게시한다", async () => {
  const app = await mount(true);
  try {
    await app.session.resize(40, 2, "fixture-lease");
    app.session.finish(0);
    expect(app.session.frame().exited).toBe(true); expect(app.session.frame().exitCode).toBe(0);
  } finally { await app.close(); }
});

test("일반 셸 PTY는 재출력을 기다리지 않고 기존 리사이즈 동작을 유지한다", async () => {
  const app = await mount(false);
  try {
    await app.session.resize(40, 2, "fixture-lease");
    expect(app.session.frame().cols).toBe(40); expect(app.session.frame().ansi).toContain("OLD-OUTPUT");
  } finally { await app.close(); }
});
