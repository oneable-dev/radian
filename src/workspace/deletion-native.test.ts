import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { createDirectoryMonitor, pathIdentity, sameIdentity } from "./deletion-native.ts";

const supported = process.platform === "darwin" || process.platform === "linux";

function openDescriptors(): number {
  return readdirSync("/dev/fd").length;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-deletion-native-")));
  const parent = join(root, "parent");
  const target = join(parent, "checkout");
  await mkdir(target, { recursive: true });

  return { root, parent, target, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test.skipIf(!supported)("Removing a held directory reports an unlink for that inode", async () => {
  const paths = await fixture();
  const { monitor } = createDirectoryMonitor();
  try {
    const held = expectOk(monitor.hold(paths.target));

    await rmdir(paths.target);
    expectOk(monitor.collect());

    expect(held.signals()).toEqual({
      unlinked: true,
      renamed: false,
      revoked: false,
      failed: false,
    });
  } finally {
    monitor.close();
    await paths.cleanup();
  }
});

test.skipIf(!supported)(
  "Renaming a held directory or its parent never reports an unlink",
  async () => {
    const paths = await fixture();
    const { monitor } = createDirectoryMonitor();
    try {
      const target = expectOk(monitor.hold(paths.target));
      const second = join(paths.root, "second");
      await mkdir(second);
      const viaParent = expectOk(monitor.hold(second));

      // A direct rename reports NOTE_RENAME; a parent move reports nothing for the child.
      await rename(paths.target, join(paths.parent, "renamed"));
      await rename(paths.root, `${paths.root}-moved`);
      await rename(`${paths.root}-moved`, paths.root);
      expectOk(monitor.collect());

      expect(target.signals()).toEqual({
        unlinked: false,
        renamed: true,
        revoked: false,
        failed: false,
      });
      expect(viaParent.signals().unlinked).toBe(false);
    } finally {
      monitor.close();
      await paths.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "Linux retains rename history when a moved directory is unlinked before collection",
  async () => {
    const paths = await fixture();
    const { monitor } = createDirectoryMonitor();
    try {
      const held = expectOk(monitor.hold(paths.target));
      const moved = join(paths.root, "moved");

      await rename(paths.target, moved);
      await rmdir(moved);
      expectOk(monitor.collect());

      expect(held.signals().unlinked).toBe(true);
      expect(held.signals().renamed).toBe(true);
      expect(held.signals().failed).toBe(false);
    } finally {
      monitor.close();
      await paths.cleanup();
    }
  },
);

test.skipIf(!supported)(
  "Collecting without pending events neither blocks nor invents evidence",
  async () => {
    const paths = await fixture();
    const { monitor } = createDirectoryMonitor();
    try {
      const held = expectOk(monitor.hold(paths.target));
      const started = performance.now();

      expectOk(monitor.collect());

      expect(performance.now() - started).toBeLessThan(100);
      expect(held.signals().unlinked).toBe(false);
    } finally {
      monitor.close();
      await paths.cleanup();
    }
  },
);

test.skipIf(!supported)("Holding missing paths fails with the filesystem code", async () => {
  const paths = await fixture();
  const { monitor } = createDirectoryMonitor();
  try {
    const error = expectError(monitor.hold(join(paths.parent, "missing")));

    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).systemCode).toBe("ENOENT");
  } finally {
    monitor.close();
    await paths.cleanup();
  }
});

test.skipIf(!supported)("Releasing and closing leave no descriptors behind", async () => {
  const paths = await fixture();
  const before = openDescriptors();
  const { monitor } = createDirectoryMonitor();
  try {
    const first = expectOk(monitor.hold(paths.target));
    expectOk(monitor.hold(paths.parent));
    expect(openDescriptors()).toBeGreaterThan(before);

    first.release();
    first.release();
    monitor.close();
    monitor.close();

    expect(openDescriptors()).toBe(before);
  } finally {
    monitor.close();
    await paths.cleanup();
  }
});

test("Path identities distinguish a recreated directory at the same path", async () => {
  const paths = await fixture();
  try {
    const original = expectOk(pathIdentity(paths.target));
    await rmdir(paths.target);
    await mkdir(paths.target);

    const recreated = expectOk(pathIdentity(paths.target));

    expect(sameIdentity(original, recreated)).toBe(false);
    expect(sameIdentity(recreated, expectOk(pathIdentity(paths.target)))).toBe(true);
  } finally {
    await paths.cleanup();
  }
});
