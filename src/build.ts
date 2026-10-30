import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaults = ["pi-mcp-adapter", "pi-web-access"];
const peers = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "typebox",
];

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

async function packageRoot(name: string, from: string): Promise<string> {
  // Physical lookup must precede Bun's builtin replacements for undici, ws and
  // node-fetch: builtin specifiers are not package filesystem entrypoints.
  for (let directory = from; ;) {
    const root = join(directory, "node_modules", name);
    if (await Bun.file(join(root, "package.json")).exists()) return realpath(root);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  let entry: string | undefined;
  try {
    entry = Bun.resolveSync(name, from);
  } catch {
    /* Type-only packages have no import entry. */
  }
  if (entry && isAbsolute(entry)) {
    for (let directory = dirname(entry); ;) {
      const file = Bun.file(join(directory, "package.json"));
      if (await file.exists()) {
        const manifest: Partial<Manifest> = await file.json();
        if (manifest.name === name && manifest.version) return realpath(directory);
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error(`Cannot locate physical runtime package ${name} from ${from}.`);
}

/** Preserve each package's dependency scope, including multiple versions and cycles. */
async function copyRuntimePackages(modules: string, from: string): Promise<void> {
  const copied = new Map<string, string>();
  const copyPackage = async (source: string): Promise<string> => {
    const existing = copied.get(source);
    if (existing) return existing;
    const manifest: Manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    const destination = join(
      modules,
      ".store",
      `${manifest.name.replaceAll("/", "+")}@${manifest.version}-${createHash("sha256").update(relative(from, source)).digest("hex").slice(0, 8)}`,
    );
    copied.set(source, destination);
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const first = relative(source, path).split(/[\\/]/u)[0];
        return first !== "node_modules" && first !== ".git";
      },
    });
    const required = new Set(
      Object.keys(manifest.dependencies ?? {}).filter(
        (name) => !manifest.optionalDependencies?.[name],
      ),
    );
    const dependencies = new Set([
      ...required,
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of dependencies) {
      let root: string;
      try {
        root = await packageRoot(name, source);
      } catch (error) {
        // Optional peers and platform-specific native packages need not exist on this target.
        if (!required.has(name)) continue;
        throw error;
      }
      const target = await copyPackage(root);
      const link = join(destination, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), target), link);
    }
    return destination;
  };
  for (const name of [...defaults, ...peers]) {
    const root = await copyPackage(await packageRoot(name, from));
    const link = join(modules, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), root), link);
  }
}

export async function buildDistribution(outfile = "dist/radian"): Promise<void> {
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const binary = resolve(outfile);
  const packages = join(dirname(binary), "packages");
  // Refuse to replace unrelated directories, even with a custom --outfile location.
  if (existsSync(packages)) {
    const file = Bun.file(join(packages, "manifest.json"));
    if (!(await file.exists()) || (await file.json()).owner !== "radian-build") {
      throw new Error(`Refusing to replace an unowned runtime directory: ${packages}.`);
    }
    await rm(packages, { recursive: true, force: true });
  }
  await mkdir(join(packages, "node_modules"), { recursive: true });
  await writeFile(
    join(packages, "manifest.json"),
    JSON.stringify({ owner: "radian-build", defaults }, null, 2) + "\n",
  );
  await copyRuntimePackages(join(packages, "node_modules"), repository);
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      join(repository, "src/index.ts"),
      "--outfile",
      binary,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await child.exited;
  if (code !== 0) throw new Error(`Radian compilation failed with exit code ${code}.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--outfile")) {
    throw new Error("Usage: bun src/build.ts [--outfile <path>]");
  }
  await buildDistribution(args[1]);
}
