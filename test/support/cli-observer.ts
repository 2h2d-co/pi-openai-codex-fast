import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "verify_release",
    label: "Verify Release",
    description: "Report the system marker and user value.",
    parameters: Type.Object({ marker: Type.String(), value: Type.String() }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: "accepted" }], details: args, terminate: true };
    },
  });
  pi.registerCommand("release-test-reload", {
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    assert.ok(event.payload && typeof event.payload === "object");
    assert.ok("model" in event.payload);
    assert.equal(event.payload.model, ctx.model?.id);
    const tier = "service_tier" in event.payload ? event.payload.service_tier : undefined;
    const priority = ctx.model?.provider === "openai-codex-fast";
    assert.equal(tier, priority ? "priority" : undefined);
    assert.ok("instructions" in event.payload && typeof event.payload.instructions === "string");
    assert.ok("input" in event.payload && Array.isArray(event.payload.input));
    const input: unknown[] = event.payload.input;
    const prompts = [event.payload.instructions];
    for (const item of input) {
      assert.ok(item && typeof item === "object");
      if ("role" in item && item.role === "developer" && "content" in item) {
        prompts.push(JSON.stringify(item.content));
      }
    }
    const markers = prompts.flatMap((prompt) => prompt.match(/FIRST|SECOND/g) ?? []);
    pi.appendEntry("release-test-tier", { priority, marker: markers.at(-1) });
    // Make the synthetic tool round-trip deterministic rather than relying on
    // the model to choose a tool over a text answer.
    return { ...event.payload, tool_choice: "required" };
  });
}
