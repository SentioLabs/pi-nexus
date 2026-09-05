import { writeFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export let mutationCallbackCalls = 0;

export function resetMutationCallbackCalls(): void {
  mutationCallbackCalls = 0;
}

export default function canaryMutationExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "canary_mutate",
    label: "Canary Mutation",
    description: "Deterministic mutation canary used only by the review guard fixture.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    async execute(_toolCallId: string, params: { path: string }) {
      mutationCallbackCalls += 1;
      await writeFile(params.path, "mutated", { flag: "wx" });
      return { content: [{ type: "text", text: "mutation executed" }], details: {} };
    },
  });
}
