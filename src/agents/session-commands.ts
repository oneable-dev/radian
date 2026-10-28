import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import type { CompletionItem } from "./completion.ts";

export function sessionCommands(session: AgentSession): readonly CompletionItem[] {
  const commands: CompletionItem[] = session.extensionRunner
    .getRegisteredCommands()
    .map((command) => ({
      kind: "command",
      value: command.invocationName,
      description: command.description?.slice(0, 1024) ?? "Extension command",
    }));
  const names = new Set(commands.map((command) => command.value));
  for (const template of session.promptTemplates) {
    if (!names.has(template.name)) {
      commands.push({
        kind: "template",
        value: template.name,
        description: template.description.slice(0, 1024),
      });
      names.add(template.name);
    }
  }
  if (session.settingsManager.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader.getSkills().skills) {
      const value = `skill:${skill.name}`;
      if (!names.has(value)) {
        commands.push({ kind: "skill", value, description: skill.description.slice(0, 1024) });
      }
    }
  }

  return commands;
}

// SDK command failures are notifications, not rejected prompt promises. Preserve that distinction at the host boundary.
export class CommandDiagnostics {
  private readonly observers = new Set<(error: ExtensionError) => void>();

  observe(listener: (error: ExtensionError) => void): () => void {
    this.observers.add(listener);

    return () => {
      this.observers.delete(listener);
    };
  }

  private active: { name: string; failure?: ExtensionError } | undefined;

  begin(name: string): { name: string; failure?: ExtensionError } {
    const token = { name };
    this.active = token;

    return token;
  }

  end(token: { name: string }): void {
    if (this.active === token) {
      this.active = undefined;
    }
  }

  report = (error: ExtensionError): void => {
    for (const observer of this.observers) {
      observer(error);
    }
    if (
      this.active &&
      error.event === "command" &&
      error.extensionPath === `command:${this.active.name}`
    ) {
      this.active.failure = error;

      return;
    }

    console.error("[radian:extension]", error);
  };
}
