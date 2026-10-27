import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { sessionResourceLoader } from "./resource-loader.ts";

test("pi-accounts is excluded before import on initial load and reload without affecting other extensions or settings", async () => {
  // Imports have side effects; hiding handlers alone cannot block the resource.
  const directory = await mkdtemp(join(tmpdir(), "radian-resource-filter-")),
    agent = join(directory, "agent"),
    legacy = join(directory, "pi-accounts", "index.ts");
  const marker = join(directory, "legacy-imported"),
    normal = join(directory, "normal.ts"),
    normalMarker = join(directory, "normal-loaded");
  await mkdir(agent);
  await mkdir(join(directory, "pi-accounts"));
  await writeFile(
    legacy,
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export default function(pi) { pi.registerCommand("accounts", {handler:async()=>{}}); }`,
  );
  await writeFile(
    normal,
    `import {writeFileSync} from "node:fs"; export default function(pi) {writeFileSync(${JSON.stringify(normalMarker)}, "loaded"); pi.registerCommand("normal", {handler:async()=>{}});}`,
  );
  const settings = JSON.stringify({ extensions: [legacy, normal] });
  await writeFile(join(agent, "settings.json"), settings);
  const loader = sessionResourceLoader({
    cwd: directory,
    agentDir: agent,
    settingsManager: SettingsManager.create(directory, agent),
    noThemes: true,
  });
  try {
    // Reloading the same loader must not execute blocked configured resources.
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(
      loader.getExtensions().extensions.some((extension) => extension.commands.has("normal")),
    ).toBe(true);
    // Add an extension path to verify reload is not pinned to initial paths.
    await mkdir(join(agent, "extensions"));
    await writeFile(
      join(agent, "extensions", "added.ts"),
      'export default function(pi) { pi.registerCommand("after-reload", {handler:async()=>{}}); }',
    );
    await loader.reload();
    expect(
      loader.getExtensions().extensions.some((extension) => extension.commands.has("after-reload")),
    ).toBe(true);

    // Other extensions run, original settings remain unchanged, and forbidden imports never occur.
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readFile(normalMarker, "utf8")).toBe("loaded");
    expect(await readFile(join(agent, "settings.json"), "utf8")).toBe(settings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
