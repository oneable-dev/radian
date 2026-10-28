import { Command, CommanderError, Option } from "commander";
import packageInfo from "../../package.json";
import { resolve } from "node:path";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export type CliOptions = {
  demo: boolean;
  offline: boolean;
  service: boolean;
  supervisor?: boolean;
  status: boolean;
  stop: boolean;
  restart?: boolean;
  legacy?: boolean;
  noColor: boolean;
  cwd: string;
  stateRoot: string | undefined;
  config: string | undefined;
  keybindings: string | undefined;
  theme: string | undefined;
  workspaceConfig: string | undefined;
};

type RawOptions = {
  demo?: boolean;
  testRuntime?: boolean;
  runtimeService?: boolean;
  terminalSupervisor?: boolean;
  runtimeStatus?: boolean;
  stopRuntime?: boolean;
  color?: boolean;
  runtimeCwd?: string;
  stateDir?: string;
  config?: string;
  keybindings?: string;
  theme?: string;
  workspaceConfig?: string;
  legacy?: boolean;
};

export type CliAction = { kind: "output"; text: string } | { kind: "run"; options: CliOptions };

// Parsing is isolated from discovery, SDK initialization and process exit. Help and
// version must work even outside a repository, with malformed user configuration.
export function parseCli(
  args: readonly string[],
  context: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Result<CliAction, InputError> {
  let output = "";
  let errors = "";
  let operation: "status" | "stop" | "restart" | undefined;
  const program = new Command()
    .name("radian")
    .description("A terminal AI development workbench powered by Pi Agent.")
    .version(packageInfo.version)
    .exitOverride()
    .helpCommand(true)
    .allowExcessArguments(false)
    .configureOutput({
      writeOut: (text) => {
        output += text;
      },
      writeErr: (text) => {
        errors += text;
      },
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    })
    .showHelpAfterError("Use 'radian --help' for usage.")
    .option("--demo", "Show display fixtures without creating runtime sessions")
    .option("--test-runtime", "Use isolated scripted SDK responses instead of a provider")
    .option(
      "--runtime-cwd <path>",
      "Initial repository, or the target repository for --legacy commands",
    )
    .option(
      "--legacy",
      "Explicitly target an old repository-owned service (runtime status/stop only)",
    )
    .option("--state-dir <path>", "Override the runtime state directory")
    .option("--config <path>", "Select unified Radian settings")
    .option("--workspace-config <path>", "Select workspace roots configuration")
    .option("--keybindings <path>", "Select application keybindings")
    .option("--theme <path>", "Select UI theme overrides")
    .option("--no-color", "Use terminal-default colors without colored styling")
    .addOption(new Option("--runtime-status", "Alias for runtime status").hideHelp())
    .addOption(new Option("--stop-runtime", "Alias for runtime stop").hideHelp())
    .addOption(new Option("--runtime-service", "Run the internal shared daemon").hideHelp())
    .addOption(
      new Option("--terminal-supervisor", "Run the internal terminal supervisor").hideHelp(),
    )
    .action(() => {});
  const runtime = program
    .command("runtime")
    .helpCommand(true)
    .description("Manage the shared daemon for the selected state directory and live/test mode");

  runtime
    .command("status")
    .description("Print the existing shared daemon snapshot without starting it")
    .action(() => {
      operation = "status";
    });
  runtime
    .command("stop")
    .description("Explicitly stop the shared daemon and all of its repository jobs")
    .action(() => {
      operation = "stop";
    });
  runtime
    .command("restart")
    .description(
      "Stop and restart the shared daemon, preserving stored conversations and open-session intent",
    )
    .action(() => {
      operation = "restart";
    });
  runtime.action(() => runtime.help());
  try {
    program.parse([...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    if (
      error.exitCode === 0 &&
      ["commander.helpDisplayed", "commander.help", "commander.version"].includes(error.code)
    ) {
      return ok({ kind: "output", text: output || errors });
    }

    return err(new InputError((errors || error.message).trim(), { cause: error }));
  }

  const raw = program.opts<RawOptions>();
  if (raw.terminalSupervisor && args.length !== 1) {
    return err(
      new InputError("Terminal supervisor cannot be combined with other operations or settings."),
    );
  }
  const statuses = [
    operation,
    raw.runtimeStatus ? "status" : undefined,
    raw.stopRuntime ? "stop" : undefined,
  ].filter((value) => value !== undefined);
  if (new Set(statuses).size > 1 || (raw.runtimeService && statuses.length)) {
    return err(new InputError("Choose exactly one runtime operation."));
  }

  const administrative = statuses[0];
  if (raw.legacy && (!administrative || administrative === "restart")) {
    return err(new InputError("--legacy is supported only with runtime status or runtime stop."));
  }
  if (raw.demo && (raw.testRuntime || raw.runtimeService || administrative)) {
    return err(
      new InputError("--demo cannot be combined with test-runtime or runtime operations."),
    );
  }
  for (const [name, path] of Object.entries({
    "--runtime-cwd": raw.runtimeCwd,
    "--state-dir": raw.stateDir,
    "--config": raw.config,
    "--keybindings": raw.keybindings,
    "--theme": raw.theme,
    "--workspace-config": raw.workspaceConfig,
  })) {
    if (path !== undefined && (!path || path.includes("\0"))) {
      return err(new InputError(`${name} requires a nonempty local path.`));
    }
  }

  const base = context.cwd ?? process.cwd();

  return ok({
    kind: "run",
    options: {
      demo: raw.demo ?? false,
      offline: raw.testRuntime ?? false,
      service: raw.runtimeService ?? false,
      ...(raw.terminalSupervisor ? { supervisor: true } : {}),
      status: administrative === "status",
      stop: administrative === "stop",
      restart: administrative === "restart",
      legacy: raw.legacy ?? false,
      noColor: raw.color === false || Boolean((context.env ?? process.env).NO_COLOR),
      cwd: resolve(base, raw.runtimeCwd ?? "."),
      stateRoot: raw.stateDir === undefined ? undefined : resolve(base, raw.stateDir),
      config: raw.config === undefined ? undefined : resolve(base, raw.config),
      keybindings: raw.keybindings,
      theme: raw.theme,
      workspaceConfig: raw.workspaceConfig,
    },
  });
}

export function checkInteractiveHost(
  options: CliOptions,
  host: { stdinTTY: boolean; stdoutTTY: boolean; term: string | undefined },
): Result<void, InputError> {
  if (options.service || options.supervisor || options.status || options.stop || options.restart) {
    return ok(undefined);
  }
  if (!host.stdinTTY || !host.stdoutTTY) {
    return err(
      new InputError(
        "Interactive mode requires a TTY for stdin and stdout. Use --help, --version or 'runtime status' in scripts.",
      ),
    );
  }
  if (host.term === "dumb") {
    return err(
      new InputError(
        "Interactive mode requires a cursor-addressable UTF-8 terminal; TERM=dumb is unsupported. Help, version and runtime commands remain available.",
      ),
    );
  }

  return ok(undefined);
}
