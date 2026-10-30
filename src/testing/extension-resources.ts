import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Compile the production loader independently so its standalone path runs away from the checkout. */
export async function probeExtensionResources(binary: string, directory: string): Promise<void> {
  const entry = join(directory, "resource-probe.ts");
  const probe = join(dirname(binary), "resource-probe");
  const agent = join(directory, "agent");
  await mkdir(agent, { recursive: true });
  const loader = fileURLToPath(new URL("../agents/resource-loader.ts", import.meta.url));
  const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  await writeFile(
    entry,
    `
    import assert from "node:assert/strict";
    import { SettingsManager } from ${JSON.stringify(sdk)};
    import { sessionResourceLoader } from ${JSON.stringify(loader)};
    const loader = sessionResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: SettingsManager.inMemory({}), noContextFiles: true, noThemes: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 2);
    const tools = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
    for (const name of ["mcp", "web_enable"]) assert(tools.includes(name), name);
    assert(!tools.includes("subagent"));
    assert(!loader.getSkills().skills.some(skill => ["pi-subagents", "council-mode"].includes(skill.name)));
    loader.getExtensions().runtime.invalidate("Resource probe completed");
    console.log("Standalone default resources loaded without checkout dependencies.");
  `,
  );
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      entry,
      "--outfile",
      probe,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [buildCode, buildOut, buildError] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (buildCode !== 0)
    throw new Error(`Resource probe compilation failed: ${buildOut}\n${buildError}`);
  const child = Bun.spawn([probe], {
    cwd: directory,
    env: {
      HOME: directory,
      TMPDIR: directory,
      PATH: "",
      PI_CODING_AGENT_DIR: agent,
      PI_PACKAGE_DIR: join(
        dirname(binary),
        "packages",
        "node_modules",
        "@earendil-works/pi-coding-agent",
      ),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0 || !stdout.includes("Standalone default resources loaded")) {
      throw new Error(`Standalone resource probe failed (${code}): ${stderr}\n${stdout}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
