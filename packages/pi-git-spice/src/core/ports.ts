import type {
  ArchivedSessionBinding,
  ChangeRequestSnapshot,
  LeaseOwner,
  LeaseScope,
  LeaseSnapshot,
  OperationPlan,
  OperationRequest,
  OperationResult,
  RepositoryIdentity,
  SessionBinding,
  StackSnapshot,
  TaskReference,
  WorkflowState,
} from "./contracts.ts";

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly truncated: boolean;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface GitAdapter {
  identify(cwd: string, signal?: AbortSignal): Promise<RepositoryIdentity>;
  createBranch(branch: string, base: string, cwd: string, signal?: AbortSignal): Promise<void>;
  inspectWorktree(path: string, signal?: AbortSignal): Promise<{
    readonly head: string;
    readonly dirty: boolean;
    readonly operation: "rebase" | "merge" | "cherry-pick" | "revert" | null;
  }>;
}

export interface GitSpiceAdapter {
  isInitialized(cwd: string, signal?: AbortSignal): Promise<boolean>;
  readTopology(cwd: string, includeChangeRequests: boolean, signal?: AbortSignal): Promise<{
    readonly branches: readonly {
      readonly name: string;
      readonly base: string | null;
      readonly up: readonly string[];
      readonly needsRestack: boolean;
      readonly worktreePath: string | null;
      readonly changeRequest: ChangeRequestSnapshot | null;
    }[];
  }>;
  trackBranch(branch: string, base: string, cwd: string, signal?: AbortSignal): Promise<void>;
  restackBranch(branch: string, worktreePath: string, signal?: AbortSignal): Promise<void>;
  syncRepository(trunkWorktree: string, signal?: AbortSignal): Promise<void>;
  submitStack(
    branch: string | null,
    options: { readonly draft: boolean; readonly fillFromCommits: boolean },
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WorktrunkAdapter {
  isAvailable(cwd: string, signal?: AbortSignal): Promise<boolean>;
  list(cwd: string, signal?: AbortSignal): Promise<
    readonly { readonly branch: string | null; readonly path: string; readonly current: boolean }[]
  >;
  ensureWorktree(branch: string, cwd: string, signal?: AbortSignal): Promise<string>;
  removeWorktree(branch: string, cwd: string, signal?: AbortSignal): Promise<void>;
}

export interface SessionAdapter {
  validate(binding: SessionBinding): Promise<boolean>;
  forkCanonical(
    repository: RepositoryIdentity,
    branch: string,
    worktreePath: string,
    task: TaskReference | null,
  ): Promise<SessionBinding>;
  archiveToTrunk(input: {
    readonly binding: SessionBinding;
    readonly retiredHead: string;
    readonly trunkWorktreePath: string;
  }): Promise<ArchivedSessionBinding>;
  switchTo(sessionFile: string): Promise<{ readonly cancelled: boolean }>;
}

export interface WorkflowStateStore {
  load(repository: RepositoryIdentity): Promise<WorkflowState>;
  save(repository: RepositoryIdentity, state: WorkflowState): Promise<void>;
}

export interface LeaseStore {
  acquire(input: {
    readonly repository: RepositoryIdentity;
    readonly scope: LeaseScope;
    readonly resourceKey: string;
    readonly operation: string;
    readonly owner: LeaseOwner;
    readonly ttlMs: number;
  }): Promise<LeaseSnapshot>;
  renew(lease: LeaseSnapshot, ttlMs: number): Promise<LeaseSnapshot>;
  release(lease: LeaseSnapshot): Promise<void>;
  list(repository: RepositoryIdentity): Promise<readonly LeaseSnapshot[]>;
}

export interface IssueAdapter {
  readonly provider: string;
  isAvailable(cwd: string): Promise<boolean>;
  resolve(reference: TaskReference, cwd: string): Promise<TaskReference | null>;
}

export interface WorkflowCoordinator {
  snapshot(signal?: AbortSignal): Promise<StackSnapshot>;
  plan(request: OperationRequest, signal?: AbortSignal): Promise<OperationPlan>;
  execute(plan: OperationPlan, signal?: AbortSignal): Promise<OperationResult>;
}
