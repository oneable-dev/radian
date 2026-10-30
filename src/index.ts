import { checkInteractiveHost, parseCli } from "./app/cli.ts";
import { reportUnexpected, type ExpectedError } from "./errors.ts";
import { ok, type Result } from "./result.ts";
import { selfLaunch } from "./runtime/launch.ts";
import { dirname, join } from "node:path";

function bundledSdkDirectory(): void {
  if (Bun.isStandaloneExecutable) {
    process.env.PI_PACKAGE_DIR ??= join(
      dirname(process.execPath),
      "packages",
      "node_modules",
      "@earendil-works/pi-coding-agent",
    );
  }
}

async function run(): Promise<Result<void, ExpectedError>> {
  const parsed = parseCli(process.argv.slice(2));
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.kind === "output") {
    process.stdout.write(parsed.value.text);

    return ok(undefined);
  }

  const options = parsed.value.options;
  if (options.noColor) {
    process.env.NO_COLOR = "1";
  }

  const host = checkInteractiveHost(options, {
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    term: process.env.TERM,
  });
  if (!host.ok) {
    return host;
  }

  // Internal terminal children must not initialize UI, SDK resources or user settings.
  if (options.supervisor) {
    const { runTerminalSupervisor } = await import("./terminal/terminal-supervisor.ts");
    return runTerminalSupervisor();
  }

  // Never initialize SDK/resources, scan roots, or attach/start a service for help,
  // version, invalid arguments, or an unsupported interactive host.
  bundledSdkDirectory();
  const { main } = await import("./app/bootstrap.ts");

  return main(options, selfLaunch(new URL(import.meta.url)));
}

try {
  const result = await run();
  if (!result.ok) {
    process.stderr.write(`[${result.error.code}] ${result.error.message}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  reportUnexpected(error, "application");
  process.exitCode = 1;
}
