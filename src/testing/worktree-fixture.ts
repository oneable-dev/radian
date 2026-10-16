import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepository } from "../workspace/discovery.ts";

export async function createWorktreeFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-worktrees-")));
  const main = join(directory, "main");
  const feature = join(directory, "feature");
  async function git(cwd: string, args: string[]): Promise<void> {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "core.hooksPath=" + join(directory, "empty-hooks"), "-c", "commit.gpgsign=false", "-c", "user.name=Radian Fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${output}${error}`);
  }
  try {
    await mkdir(main);
    await git(main, ["init", "--initial-branch=main"]);
    await writeFile(join(main, "workspace.txt"), "main-worktree-marker\n");
    await git(main, ["add", "workspace.txt"]);
    await git(main, ["commit", "-m", "Create main worktree marker"]);
    await git(main, ["worktree", "add", "-b", "feature/probe", feature]);
    await writeFile(join(feature, "workspace.txt"), "feature-worktree-marker\n");
    await git(feature, ["commit", "-am", "Create feature worktree marker"]);
    const repository = await discoverRepository(main); if (!repository.ok) throw repository.error;
    return { directory, main, feature, repository: repository.value,
      cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const fixture = await createWorktreeFixture();
  const entry = join(import.meta.dir, "..", "index.ts");
  console.log(`Created an isolated repository and linked worktree:\n${fixture.directory}\n`);
  const launch = `bun ${JSON.stringify(entry)} --test-runtime --state-dir ${JSON.stringify(join(fixture.directory, "state"))}`;
  console.log(`cd ${JSON.stringify(fixture.main)}\n${launch}`);
  console.log("\nUse New session in each worktree. Default Ctrl+e focuses the Agent prompt; Enter submits.");
  console.log("Scripted commands: slow (10s stream), read (workspace marker), write (probe file), delegate (owned slow child).");
  console.log("Default leader: Ctrl+Space. Then t creates a terminal, x closes it, c detaches the TUI. Ctrl+C interrupts the native program.");
  console.log("Shell commands are real, not sandboxed. Test runtime uses clean shell/Neovim configuration.");
  console.log(`Save editor work, detach, then stop this test service before deleting the fixture:\n${launch} --stop-runtime\nrm -rf ${JSON.stringify(fixture.directory)}`);
}
