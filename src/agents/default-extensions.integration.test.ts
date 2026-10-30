import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Actual default packages load resources, management UIs, MCP tools and Web Access in an isolated profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-default-extension-integration-"));
  const agent = join(directory, "agent");
  await mkdir(agent);
  const entry = fileURLToPath(new URL("../testing/default-extensions-fixture.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", entry], {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: directory,
      TMPDIR: directory,
      PI_CODING_AGENT_DIR: agent,
      XDG_CONFIG_HOME: join(directory, "config"),
      RADIAN_TEST_FIXTURE_ROOT: directory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 25000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(stdout.trim())).toMatchObject({
      skills: 1,
      templates: 0,
      modelCalls: 10,
      childExtensions: true,
      privateFetchBlocked: true,
    });
  } finally {
    clearTimeout(timeout);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
