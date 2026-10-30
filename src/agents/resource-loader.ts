import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defaultPackagePaths, defaultPackageSettings } from "./default-packages.ts";
import { withComponentCommands } from "./extension-capabilities.ts";

type Options = ConstructorParameters<typeof DefaultResourceLoader>[0] & {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  defaultPackagePaths?: readonly string[];
};

export function sessionResourceLoader(options: Options): ResourceLoader {
  const { defaultPackagePaths: paths = defaultPackagePaths(), ...sdkOptions } = options;
  return new DefaultResourceLoader({
    ...sdkOptions,
    settingsManager: defaultPackageSettings({ ...options, defaultPackagePaths: paths }),
    extensionsOverride: (result) =>
      withComponentCommands(options.extensionsOverride?.(result) ?? result),
  });
}
