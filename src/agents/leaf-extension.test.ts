import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { expectOk } from "../testing/results.ts";
import { err } from "../result.ts";
import { CapabilityError } from "../errors.ts";

test.each(["subagent", "radian-subagent", "radian_subagent"])(
  "Radian leaf sessions cannot gain delegation tool %s from discovered extensions",
  async (name) => {
    const files = await createWorktreeFixture();
    const agent = join(files.directory, "agent");
    const extensions = join(agent, "extensions");
    const marker = join(files.directory, "delegated");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "delegation.ts"),
      `
    import {writeFileSync} from "node:fs";
    export default function(pi) {
      pi.registerTool({name:${JSON.stringify(name)},label:"Delegate",description:"Fixture delegation",
        parameters:{type:"object",properties:{}}, execute:async()=>{
          writeFileSync(${JSON.stringify(marker)},"unexpected");
          return {content:[{type:"text",text:"Unexpected delegation"}]};
        }});
    }
  `,
    );
    const offline = await offlineRuntime(agent);
    const executor = await piSessionFactory({
      ...offline,
      streamFn(model, context, options) {
        if (context.messages.at(-1)?.role !== "user")
          return offline.streamFn!(model, context, options);
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [{ type: "toolCall", id: "blocked", name, arguments: {} }];
        message.stopReason = "toolUse";
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
        return stream;
      },
    })({
      cwd: files.main,
      role: "subagent",
      spawnSubagent: async () => err(new CapabilityError("No nested child expected")),
    });
    try {
      expectOk(await executor.prompt("Do not delegate"));

      expect(await Bun.file(marker).exists()).toBe(false);
      expect(
        executor.state.sections?.some(
          (section) => section.kind === "tool" && section.status === "error",
        ),
      ).toBe(true);
    } finally {
      await executor.close();
      await files.cleanup();
    }
  },
);
