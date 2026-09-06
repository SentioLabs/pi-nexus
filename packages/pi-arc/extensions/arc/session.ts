import { spawn } from "node:child_process";

// Resolve identity for each command: sessions can change during a Pi process.
// Never mutate process.env, which is also inherited by independently spawned agents.
type ArcSessionContext = {
  cwd: string;
  signal?: AbortSignal;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
};

export type ArcCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export function registerArcSession(ctx: ArcSessionContext): Promise<ArcCommandResult> {
  const sessionID = ctx.sessionManager.getSessionId();
  return runArcCommand(["ai", "session", "start", "--stdin"], ctx, {
    stdin: {
      session_id: sessionID,
      cwd: ctx.cwd,
      transcript_path: ctx.sessionManager.getSessionFile() ?? "",
    },
    sessionID,
  });
}

export function runArcCommand(
  args: string[],
  ctx: ArcSessionContext,
  options: { stdin?: unknown; timeoutMs?: number; sessionID?: string } = {},
): Promise<ArcCommandResult> {
  const { signal } = ctx;
  const { stdin, timeoutMs = 15_000, sessionID = ctx.sessionManager.getSessionId() } = options;
  if (!sessionID) {
    return Promise.resolve({ code: 2, stdout: "", stderr: "Pi session ID is required" });
  }
  return new Promise((resolve) => {
    const child = spawn("arc", args, {
      cwd: ctx.cwd,
      env: { ...process.env, ARC_SESSION_ID: sessionID },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ArcCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abort);
      resolve(result);
    };

    const abort = () => {
      child.kill("SIGTERM");
    };

    const timeout = setTimeout(() => {
      stderr += `Timed out after ${timeoutMs}ms`;
      child.kill("SIGTERM");
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", (error) => {
      stderr += error.message;
    });
    child.on("error", (error) => {
      finish({ code: 127, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });

    child.stdin.end(stdin === undefined ? undefined : `${JSON.stringify(stdin)}\n`);
  });
}
