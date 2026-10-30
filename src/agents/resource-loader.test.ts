import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { sessionResourceLoader } from "./resource-loader.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "radian-default-packages-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  const project = join(cwd, ".pi");
  await mkdir(agentDir);
  await mkdir(project);
  const globalSettings = join(agentDir, "settings.json");
  const projectSettings = join(project, "settings.json");
  await writeFile(globalSettings, "{}");
  await writeFile(projectSettings, "{}");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = (defaults: readonly string[]) =>
    sessionResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      defaultPackagePaths: defaults,
      noThemes: true,
      noContextFiles: true,
    });
  return { cwd, agentDir, project, globalSettings, projectSettings, settingsManager, loader };
}

async function packageFixture(directory: string, label: string, name = "fixture-default") {
  const root = join(directory, label);
  await mkdir(join(root, "skills", "choice"), { recursive: true });
  await mkdir(join(root, "prompts"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      pi: { extensions: ["index.ts"], skills: ["skills"], prompts: ["prompts"] },
    }),
  );
  await writeFile(
    join(root, "index.ts"),
    `
    import {appendFileSync} from "node:fs";
    export default function(pi) {
      appendFileSync(${JSON.stringify(join(root, "loaded"))}, "loaded\\n");
      pi.registerCommand(${JSON.stringify(label)}, {handler: async () => {}});
    }
  `,
  );
  await writeFile(
    join(root, "skills", "choice", "SKILL.md"),
    `---\nname: choice\ndescription: ${label}\n---\n${label}\n`,
  );
  await writeFile(
    join(root, "prompts", "choice.md"),
    `---\ndescription: ${label}\n---\n${label}\n`,
  );
  return root;
}

function commandNames(loader: ReturnType<typeof sessionResourceLoader>) {
  return loader.getExtensions().extensions.flatMap((extension) => [...extension.commands.keys()]);
}

test("Missing selections load the complete default package without persisting registrations", async () => {
  // A default is an installed package root, not merely an extension entry file.
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  expect(commandNames(loader)).toEqual(["bundled"]);
  expect(loader.getSkills().skills.map((skill) => skill.description)).toEqual(["bundled"]);
  expect(loader.getPrompts().prompts.map((prompt) => prompt.description)).toEqual(["bundled"]);
  expect(await readFile(app.globalSettings, "utf8")).toBe("{}");
  expect(await readFile(app.projectSettings, "utf8")).toBe("{}");
  expect(app.settingsManager.getPackages()).toEqual([]);
});

test("A configured user copy owns extensions, skills and prompts before the bundled copy imports", async () => {
  // Different filesystem roots with the same manifest name are the same package selection.
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const user = await packageFixture(app.agentDir, "user");
  const settings = JSON.stringify({ packages: ["./user"] });
  await writeFile(app.globalSettings, settings);
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  expect(commandNames(loader)).toEqual(["user"]);
  expect(loader.getSkills().skills.map((skill) => skill.description)).toEqual(["user"]);
  expect(loader.getPrompts().prompts.map((prompt) => prompt.description)).toEqual(["user"]);
  expect(await Bun.file(join(bundled, "loaded")).exists()).toBe(false);
  expect(await Bun.file(join(user, "loaded")).exists()).toBe(true);
  expect(await readFile(app.globalSettings, "utf8")).toBe(settings);
});

test("A project package wins over user and default copies even when their paths differ", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const user = await packageFixture(app.agentDir, "user");
  const project = await packageFixture(app.project, "project");
  await writeFile(app.globalSettings, JSON.stringify({ packages: [user] }));
  await writeFile(app.projectSettings, JSON.stringify({ packages: ["./project"] }));
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  expect(commandNames(loader)).toEqual(["project"]);
  expect(loader.getSkills().skills.map((skill) => skill.description)).toEqual(["project"]);
  expect(loader.getPrompts().prompts.map((prompt) => prompt.description)).toEqual(["project"]);
  expect(await Bun.file(join(bundled, "loaded")).exists()).toBe(false);
  expect(await Bun.file(join(user, "loaded")).exists()).toBe(false);
  expect(await Bun.file(join(project, "loaded")).exists()).toBe(true);
});

test("Explicit empty resource filters do not reactivate a bundled fallback", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const user = await packageFixture(app.agentDir, "user");
  await writeFile(
    app.globalSettings,
    JSON.stringify({
      packages: [{ source: user, extensions: [], skills: [], prompts: [], themes: [] }],
    }),
  );
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  expect(commandNames(loader)).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getPrompts().prompts).toEqual([]);
  expect(await Bun.file(join(bundled, "loaded")).exists()).toBe(false);
  expect(await Bun.file(join(user, "loaded")).exists()).toBe(false);
});

test("An entirely disabled npm selection suppresses defaults without installing the package", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  await writeFile(
    app.globalSettings,
    JSON.stringify({
      packages: [
        {
          source: "npm:fixture-default@999.0.0",
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
        },
      ],
    }),
  );
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  expect(commandNames(loader)).toEqual([]);
  expect(await Bun.file(join(bundled, "loaded")).exists()).toBe(false);
  expect(await Bun.file(join(app.agentDir, "npm", "package.json")).exists()).toBe(false);
});

test("Autoloaded user extension links suppress the bundled package without mixing its resources", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const user = await packageFixture(app.agentDir, "user");
  await mkdir(join(app.agentDir, "extensions"));
  await symlink(join(user, "index.ts"), join(app.agentDir, "extensions", "linked.ts"));
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(commandNames(loader)).toEqual(["user"]);
  expect(await Bun.file(join(bundled, "loaded")).exists()).toBe(false);
  // A standalone extension entry follows standard SDK discovery, not package-root discovery.
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getPrompts().prompts).toEqual([]);
});

test("Disabled autoloaded user links do not reactivate the default copy", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const user = await packageFixture(app.agentDir, "user");
  await mkdir(join(app.agentDir, "extensions"));
  await symlink(join(user, "index.ts"), join(app.agentDir, "extensions", "linked.ts"));
  await writeFile(app.globalSettings, JSON.stringify({ extensions: ["-./extensions/linked.ts"] }));
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(commandNames(loader)).toEqual([]);
  expect(await Bun.file(join(bundled, "loaded")).exists()).toBe(false);
  expect(await Bun.file(join(user, "loaded")).exists()).toBe(false);
});

test("Reload selects the latest settings instead of retaining the previous default", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const user = await packageFixture(app.agentDir, "user");
  const loader = app.loader([bundled]);
  await loader.reload();
  expect(commandNames(loader)).toEqual(["bundled"]);

  await writeFile(app.globalSettings, JSON.stringify({ packages: [user] }));
  await loader.reload();

  expect(commandNames(loader)).toEqual(["user"]);
  expect(loader.getSkills().skills.map((skill) => skill.description)).toEqual(["user"]);
  expect(loader.getPrompts().prompts.map((prompt) => prompt.description)).toEqual(["user"]);
});

test("Symlinked duplicate user packages initialize once", async () => {
  const app = await fixture();
  const user = await packageFixture(app.agentDir, "user");
  const alias = join(app.agentDir, "linked-user");
  await symlink(user, alias);
  await writeFile(app.globalSettings, JSON.stringify({ packages: [user, alias] }));
  const loader = app.loader([]);

  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  expect(commandNames(loader)).toEqual(["user"]);
  expect(await readFile(join(user, "loaded"), "utf8")).toBe("loaded\n");
});

test("A failing user extension reports its error without silently loading the default", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const user = await packageFixture(app.agentDir, "user");
  await writeFile(
    join(user, "index.ts"),
    'throw new Error("User fixture failed"); export default function() {}',
  );
  await writeFile(app.globalSettings, JSON.stringify({ packages: [user] }));
  const loader = app.loader([bundled]);

  await loader.reload();

  expect(loader.getExtensions().errors).toHaveLength(1);
  expect(loader.getExtensions().errors[0]!.path).toBe(join(user, "index.ts"));
  expect(commandNames(loader)).toEqual([]);
  expect(await Bun.file(join(bundled, "loaded")).exists()).toBe(false);
});

test("User packages named pi-accounts follow normal discovery with no special exclusion", async () => {
  // This inert fixture registers a command only; it never loads a real account extension.
  const app = await fixture();
  const account = await packageFixture(app.agentDir, "pi-accounts", "@fixture/pi-accounts");
  await writeFile(app.globalSettings, JSON.stringify({ packages: [account] }));
  const loader = app.loader([]);

  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  expect(commandNames(loader)).toEqual(["pi-accounts"]);
  expect(await readFile(join(account, "loaded"), "utf8")).toBe("loaded\n");
});

test("Project trust resolution does not import an untrusted project override", async () => {
  const app = await fixture();
  const bundled = await packageFixture(app.cwd, "bundled");
  const project = await packageFixture(app.project, "project");
  await writeFile(app.projectSettings, JSON.stringify({ packages: [project] }));
  const loader = app.loader([bundled]);

  await loader.reload({ resolveProjectTrust: async () => false });

  expect(commandNames(loader)).toEqual(["bundled"]);
  expect(await Bun.file(join(project, "loaded")).exists()).toBe(false);
});
