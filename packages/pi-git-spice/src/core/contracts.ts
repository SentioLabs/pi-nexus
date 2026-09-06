export const WORKFLOW_STATE_VERSION = 1 as const;

export type OperationKind =
  | "enter"
  | "prepare_branch"
  | "restack"
  | "update"
  | "submit"
  | "continue_restack"
  | "abort_restack";

export type LeaseScope =
  | "repository:topology"
  | "stack:rewrite"
  | "worktree:write";

export interface RepositoryIdentity {
  readonly key: string;
  readonly commonDir: string;
  readonly anchorCwd: string;
  readonly trunk: string;
}

export interface TaskReference {
  readonly provider: string;
  readonly id: string;
}

export interface ChangeRequestSnapshot {
  readonly id: string;
  readonly url: string;
  readonly status: "open" | "closed" | "merged" | "unknown";
}

export interface WorktreeSnapshot {
  readonly path: string;
  readonly dirty: boolean;
  readonly gitOperation: "rebase" | "merge" | "cherry-pick" | "revert" | null;
}

export interface SessionBinding {
  readonly branch: string;
  readonly worktreePath: string;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly task: TaskReference | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export interface ArchivedSessionBinding {
  readonly branch: string;
  readonly retiredHead: string;
  readonly archiveSessionFile: string;
  readonly archiveSessionId: string;
  readonly originalSessionFile: string;
  readonly trunkWorktreePath: string;
  readonly task: TaskReference | null;
  readonly retiredAt: string;
}

export interface LeaseOwner {
  readonly kind: "pi-session" | "agent" | "operation";
  readonly id: string;
  readonly sessionId: string | null;
}

export interface LeaseSnapshot {
  readonly leaseId: string;
  readonly scope: LeaseScope;
  readonly resourceKey: string;
  readonly operation: string;
  readonly owner: LeaseOwner;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export interface BranchSnapshot {
  readonly name: string;
  readonly head: string;
  readonly base: string | null;
  readonly baseRevision: string | null;
  readonly up: readonly string[];
  readonly current: boolean;
  readonly needsRestack: boolean;
  readonly baseStale: boolean;
  readonly worktree: WorktreeSnapshot | null;
  readonly session: SessionBinding | null;
  readonly lease: LeaseSnapshot | null;
  readonly task: TaskReference | null;
  readonly changeRequest: ChangeRequestSnapshot | null;
}

export interface StackSnapshot {
  readonly schemaVersion: typeof WORKFLOW_STATE_VERSION;
  readonly repository: RepositoryIdentity;
  readonly refreshedAt: string;
  readonly branches: readonly BranchSnapshot[];
}

export type OperationRequest =
  | { readonly kind: "enter"; readonly branch: string; readonly createWorktree: boolean }
  | {
      readonly kind: "prepare_branch";
      readonly branch: string;
      readonly base: string;
      readonly task: TaskReference | null;
    }
  | { readonly kind: "restack"; readonly branch: string | null }
  | { readonly kind: "update"; readonly branch: string | null }
  | {
      readonly kind: "submit";
      readonly branch: string | null;
      readonly draft: boolean;
      readonly fillFromCommits: boolean;
    }
  | { readonly kind: "continue_restack"; readonly branch: string }
  | { readonly kind: "abort_restack"; readonly branch: string };

export interface OperationStep {
  readonly index: number;
  readonly effect:
    | "create_branch"
    | "track_branch"
    | "create_worktree"
    | "bind_session"
    | "switch_session"
    | "archive_session"
    | "remove_worktree"
    | "sync_repository"
    | "restore_worktree"
    | "restack_branch"
    | "submit_stack"
    | "continue_rebase"
    | "abort_rebase";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface OperationPlan {
  readonly planId: string;
  readonly repositoryKey: string;
  readonly kind: OperationKind;
  readonly preconditionToken: string;
  readonly requiresConfirmation: boolean;
  readonly steps: readonly OperationStep[];
  readonly warnings: readonly string[];
}

export interface ConflictHandoff {
  readonly branch: string;
  readonly worktreePath: string;
  readonly sessionFile: string | null;
  readonly conflictedFiles: readonly string[];
}

export interface OperationResult {
  readonly status: "completed" | "blocked" | "conflict" | "cancelled";
  readonly snapshot: StackSnapshot;
  readonly enteredSessionFile: string | null;
  readonly conflict: ConflictHandoff | null;
  readonly notices: readonly string[];
}

export interface ActiveOperation {
  readonly operationId: string;
  readonly kind: "prepare_branch" | "restack" | "update";
  readonly repositoryKey: string;
  readonly status: "running" | "paused_conflict" | "rolling_back" | "aborted";
  readonly steps: readonly OperationStep[];
  readonly completedStepCount: number;
  readonly createdArtifacts: readonly {
    readonly kind: "branch" | "tracking" | "worktree" | "session" | "binding" | "archive";
    readonly identifier: string;
    readonly expectedRevision: string | null;
  }[];
  readonly expectedHeads: Readonly<Record<string, string>>;
  readonly conflictBranch: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface WorkflowState {
  readonly schemaVersion: typeof WORKFLOW_STATE_VERSION;
  readonly repositoryKey: string;
  readonly bindings: Readonly<Record<string, SessionBinding>>;
  readonly archivedBindings: readonly ArchivedSessionBinding[];
  readonly activeOperation: ActiveOperation | null;
}

export interface WorkflowEventMap {
  "stack-workflow:activated": { readonly repositoryKey: string };
  "stack-workflow:snapshot-changed": StackSnapshot;
  "stack-workflow:branch-bound": SessionBinding;
  "stack-workflow:worktree-entered": SessionBinding;
  "stack-workflow:lease-changed": LeaseSnapshot | null;
  "stack-workflow:base-stale": { readonly branch: string; readonly baseRevision: string };
  "stack-workflow:conflict": ConflictHandoff;
}
