import { expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { withStateLock } from "./state-lock.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-state-lock-"));

  return {
    directory,
    lock: join(directory, "state.lock"),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("Same-process holders run one at a time in call order", async () => {
  const app = await fixture();
  try {
    const events: string[] = [];
    const held = Promise.withResolvers<void>();
    const first = withStateLock(app.lock, async () => {
      events.push("first:start");
      await held.promise;
      events.push("first:end");

      return ok(1);
    });
    const second = withStateLock(app.lock, async () => {
      events.push("second");

      return ok(2);
    });

    await Bun.sleep(20);
    expect(events).toEqual(["first:start"]);
    held.resolve();

    expect([expectOk(await first), expectOk(await second)]).toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  } finally {
    await app.close();
  }
});

test("Another process holding the lock blocks entry until it releases", async () => {
  // A TUI process and the daemon must not interleave read-modify-write of shared state.
  const app = await fixture();
  try {
    const ready = join(app.directory, "ready");
    const release = join(app.directory, "release");
    const script = join(app.directory, "holder.ts");
    await writeFile(
      script,
      `import { withStateLock } from ${JSON.stringify(join(import.meta.dir, "state-lock.ts"))};
       import { ok } from ${JSON.stringify(join(import.meta.dir, "..", "result.ts"))};
       import { existsSync, writeFileSync } from "node:fs";
       await withStateLock(process.argv[2], async () => {
         writeFileSync(process.argv[3], "held");
         while (!existsSync(process.argv[4])) await Bun.sleep(5);
         return ok(undefined);
       });`,
    );
    const child = Bun.spawn([process.execPath, script, app.lock, ready, release], {
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      while (!(await Bun.file(ready).exists())) await Bun.sleep(5);

      let entered = false;
      const contender = withStateLock(app.lock, async () => {
        entered = true;

        return ok(undefined);
      });
      await Bun.sleep(100);
      expect(entered).toBe(false);

      await writeFile(release, "");
      expectOk(await contender);
      expect(entered).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    await app.close();
  }
});

test("A crashed holder releases its lock without removing the lock file", async () => {
  const app = await fixture();
  try {
    const ready = join(app.directory, "ready");
    const script = join(app.directory, "crash.ts");
    await writeFile(
      script,
      `import { withStateLock } from ${JSON.stringify(join(import.meta.dir, "state-lock.ts"))};
       import { writeFileSync } from "node:fs";
       await withStateLock(process.argv[2], async () => {
         writeFileSync(process.argv[3], "held");
         await new Promise(() => {});
         throw new Error("unreachable");
       });`,
    );
    const child = Bun.spawn([process.execPath, script, app.lock, ready], { stdout: "ignore" });
    while (!(await Bun.file(ready).exists())) await Bun.sleep(5);
    child.kill("SIGKILL");
    await child.exited;

    expectOk(await withStateLock(app.lock, async () => ok(undefined), { timeoutMs: 2000 }));
    expect(await readFile(app.lock, "utf8")).toBe("");
  } finally {
    await app.close();
  }
});

test("Contention past the timeout is an expected storage failure, not entry", async () => {
  const app = await fixture();
  try {
    const ready = join(app.directory, "ready");
    const script = join(app.directory, "holder.ts");
    await writeFile(
      script,
      `import { withStateLock } from ${JSON.stringify(join(import.meta.dir, "state-lock.ts"))};
       import { writeFileSync } from "node:fs";
       await withStateLock(process.argv[2], async () => {
         writeFileSync(process.argv[3], "held");
         await new Promise(() => {});
         throw new Error("unreachable");
       });`,
    );
    const child = Bun.spawn([process.execPath, script, app.lock, ready], { stdout: "ignore" });
    try {
      while (!(await Bun.file(ready).exists())) await Bun.sleep(5);

      const failed = expectError(
        await withStateLock(app.lock, async () => ok(undefined), { timeoutMs: 50 }),
      );
      expect(failed.code).toBe("STORAGE_FAILED");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await app.close();
  }
});

test("A symlinked or replaced lock file is refused", async () => {
  const app = await fixture();
  try {
    const target = join(app.directory, "elsewhere");
    await writeFile(target, "");
    await Bun.$`ln -s ${target} ${app.lock}`.quiet();

    expect(expectError(await withStateLock(app.lock, async () => ok(undefined))).code).toBe(
      "STORAGE_FAILED",
    );

    await rm(app.lock);
    const replaced = withStateLock(app.lock, async () => ok(undefined));
    // A lock created normally still works after the bad link is gone.
    expectOk(await replaced);
    await rename(app.lock, join(app.directory, "moved"));
    expectOk(await withStateLock(app.lock, async () => ok(undefined)));
  } finally {
    await app.close();
  }
});
