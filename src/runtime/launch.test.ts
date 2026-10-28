import { expect, test } from "bun:test";
import { childCommand, selfLaunch, type SelfLaunch } from "./launch.ts";

test.each(["--runtime-service", "--terminal-supervisor"])(
  "Source children use an explicit entrypoint and isolated Bun configuration for %s",
  (role) => {
    // A source entry with spaces must stay one argument, independent of the caller's cwd.
    const launch: SelfLaunch = {
      kind: "source",
      executable: "/tools/bun",
      entrypoint: "/project with spaces/src/index.ts",
    };

    const command = childCommand(launch, [role]);

    // Configuration suppression belongs before the source entry, not in application arguments.
    expect(command).toEqual([
      "/tools/bun",
      "--no-env-file",
      "--config=/dev/null",
      "/project with spaces/src/index.ts",
      role,
    ]);
  },
);

test.each(["--runtime-service", "--terminal-supervisor"])(
  "Binary children receive application arguments without source paths or Bun CLI flags for %s",
  (role) => {
    // A compiled executable already contains its application entrypoint and runtime.
    const launch: SelfLaunch = { kind: "binary", executable: "/installed tools/radian" };

    const command = childCommand(launch, [role]);

    // Passing a virtual bundle path here was the standalone daemon startup regression.
    expect(command).toEqual(["/installed tools/radian", role]);
  },
);

test("Source hosts resolve the supplied application URL instead of the test runner entrypoint", () => {
  // In-process callers may be test runners or SDK hosts rather than Radian's CLI.
  const entrypoint = new URL("file:///project%20with%20spaces/src/index.ts");

  const launch = selfLaunch(entrypoint);

  expect(launch).toEqual({
    kind: "source",
    executable: process.execPath,
    entrypoint: "/project with spaces/src/index.ts",
  });
});
