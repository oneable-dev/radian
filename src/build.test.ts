import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDistribution } from "./build.ts";

test("Distribution builds never delete an unrelated packages directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-build-ownership-"));
  const packages = join(directory, "packages");
  await mkdir(packages);
  const file = join(packages, "keep.txt");
  await writeFile(file, "Existing user data");
  try {
    await expect(buildDistribution(join(directory, "radian"))).rejects.toThrow(
      "unowned runtime directory",
    );

    expect(await readFile(file, "utf8")).toBe("Existing user data");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
