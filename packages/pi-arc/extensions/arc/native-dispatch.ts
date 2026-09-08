import { randomUUID } from "node:crypto";

type Events = {
  on(name: string, listener: (payload: unknown) => void): () => void;
  emit(name: string, payload: unknown): void;
};

type Intent = {
  agent: string;
  task: string;
  cwd: string;
  model?: string;
  worktree?: boolean;
};

type Receipt = {
  requestId: string;
  text: string;
  details: Record<string, unknown>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export async function dispatchArcSubagent(
  events: Events,
  available: boolean,
  intent: Intent,
  signal?: AbortSignal,
  dispatchWaitMs = 10_000,
): Promise<Receipt> {
  if (!available) {
    throw new Error(
      "arc_agent requires the loaded and enabled pi-subagents subagent tool. Check Pi package configuration and native agent availability; no fallback was launched.",
    );
  }
  if (signal?.aborted) throw new Error("arc_agent cancelled before submission; no request emitted.");

  const child = {
    agent: intent.agent,
    task: intent.task,
    ...(intent.model ? { model: intent.model } : {}),
  };
  const params = intent.worktree
    ? {
        workflowScript: `return await runs.run("arc-agent", ${JSON.stringify({ ...child, worktree: true })});`,
        cwd: intent.cwd,
        context: "fresh",
        async: true,
      }
    : { ...child, cwd: intent.cwd, context: "fresh", async: true };
  const requestId = randomUUID();
  let submitted = false;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  const failure = (message: string) =>
    new Error(
      `${message} Request ${requestId}. ${submitted ? "Submission occurred; launch outcome may be unknown. Do not retry automatically. Use native status/stop with any known identity." : "No request was emitted."}`,
    );

  try {
    return await new Promise<Receipt>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          reject(failure(message));
        }
      };

      unsubscribe = events.on(`subagents:rpc:v1:reply:${requestId}`, (payload) => {
        if (settled) return;
        if (!record(payload) || payload.requestId !== requestId) return;
        if (payload.version !== 1 || typeof payload.success !== "boolean") {
          return fail("Malformed native dispatch reply.");
        }
        if (!payload.success) {
          const error = record(payload.error) ? payload.error : {};
          return fail(
            `Native spawn failed (${typeof error.code === "string" ? error.code : "unknown"}): ${typeof error.message === "string" ? error.message : "No error detail"}`,
          );
        }

        const data = payload.data;
        if (
          !record(data)
          || data.isError === true
          || typeof data.text !== "string"
          || !record(data.details)
          || typeof data.details.runId !== "string"
          || !data.details.runId.trim()
        ) {
          return fail("Native dispatch receipt missing or malformed.");
        }
        settled = true;
        resolve({ requestId, text: data.text, details: data.details });
      });

      const abort = () => fail("Arc dispatch wait cancelled; this is not a child-stop acknowledgement.");
      signal?.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return abort();

      timer = setTimeout(
        () => fail("No compatible dispatch reply before the deadline. Check that pi-subagents is loaded and usable."),
        dispatchWaitMs,
      );
      submitted = true;
      try {
        events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "spawn", params });
      } catch (error) {
        fail(`Native request emission failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort();
    unsubscribe();
  }
}
