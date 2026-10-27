import { checkInteractiveHost, parseCli } from "./app/cli.ts";
import { reportUnexpected, type ExpectedError } from "./errors.ts";
import { ok, type Result } from "./result.ts";

async function run(): Promise<Result<void, ExpectedError>> {
  const parsed = parseCli(process.argv.slice(2));
  if (!parsed.ok) return parsed;
  if (parsed.value.kind === "output") {
    process.stdout.write(parsed.value.text);
    return ok(undefined);
  }
  const options = parsed.value.options;
  if (options.noColor) process.env.NO_COLOR = "1";
  const host = checkInteractiveHost(options, {
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    term: process.env.TERM,
  });
  if (!host.ok) return host;
  // Never initialize SDK/resources, scan roots, or attach/start a service for help,
  // version, invalid arguments, or an unsupported interactive host.
  const { main } = await import("./app/bootstrap.ts");
  return main(options);
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
