import {
  DefaultPackageManager,
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

type Options = ConstructorParameters<typeof DefaultResourceLoader>[0] & {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
};

const legacyAccounts = (path: string) => /(?:^|[\\/])pi-accounts(?:[\\/]|$)/u.test(path);

// Filter resolved paths BEFORE importing an extension. Filtering loaded handlers is too late:
// pi-accounts also registers event-bus credential sources and may migrate its own storage at load.
export function sessionResourceLoader(options: Options): ResourceLoader {
  const packages = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
  });
  // The SDK retains this array. Mutate its contents, not the loader instance: reload must
  // preserve the event bus and clear the SDK's extension-module cache in its usual lifecycle.
  const paths: string[] = [];
  const current = new DefaultResourceLoader({
    ...options,
    noExtensions: true,
    additionalExtensionPaths: paths,
  });

  return {
    getExtensions: () => current.getExtensions(),
    getSkills: () => current.getSkills(),
    getPrompts: () => current.getPrompts(),
    getThemes: () => current.getThemes(),
    getAgentsFiles: () => current.getAgentsFiles(),
    getSystemPrompt: () => current.getSystemPrompt(),
    getSystemPromptSource: () => current.getSystemPromptSource(),
    getAppendSystemPrompt: () => current.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => current.getAppendSystemPromptSources(),
    extendResources: (paths) => current.extendResources(paths),
    reload: async (reloadOptions) => {
      await options.settingsManager.reload();

      const resolved = await packages.resolve();
      const extra = await packages.resolveExtensionSources(options.additionalExtensionPaths ?? [], {
        temporary: true,
      });
      const selected = [...resolved.extensions, ...extra.extensions]
        .filter(
          (resource) =>
            resource.enabled &&
            ![resource.path, resource.metadata.packageRoot ?? "", resource.metadata.source].some(
              legacyAccounts,
            ),
        )
        .map((resource) => resource.path);

      paths.splice(0, paths.length, ...new Set(selected));
      // Normal discovery still owns skills, prompts and context; extensions use the filtered set.
      // Nothing is written to the user's global/project settings or Pi CLI configuration.
      await current.reload(reloadOptions);
    },
  };
}
