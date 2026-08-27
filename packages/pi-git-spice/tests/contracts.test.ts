import type {
  ActiveOperation,
  ArchivedSessionBinding,
  BranchSnapshot,
  LeaseSnapshot,
  OperationPlan,
  OperationRequest,
  OperationResult,
  RepositoryIdentity,
  SessionBinding,
  StackSnapshot,
  TaskReference,
  WorkflowEventMap,
  WorkflowState,
} from "../src/core/contracts.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  GitAdapter,
  GitSpiceAdapter,
  IssueAdapter,
  LeaseStore,
  SessionAdapter,
  WorkflowCoordinator,
  WorkflowStateStore,
  WorktrunkAdapter,
} from "../src/core/ports.ts";

const task = {
  provider: "arc",
  id: "pinexus-123",
} satisfies TaskReference;

const repository = {
  key: "repo-1",
  commonDir: "/repo/.git",
  anchorCwd: "/repo",
  trunk: "main",
} satisfies RepositoryIdentity;

const session = {
  branch: "feat/parser",
  worktreePath: "/worktrees/feat-parser",
  sessionFile: "/sessions/feat-parser.jsonl",
  sessionId: "session-1",
  task,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
} satisfies SessionBinding;

const request = {
  kind: "update",
  branch: "feat/parser",
} satisfies OperationRequest;

const branch = {
  name: "feat/parser",
  head: "0123456789abcdef",
  base: "main",
  baseRevision: "fedcba9876543210",
  up: [],
  current: true,
  needsRestack: false,
  baseStale: false,
  worktree: null,
  session,
  lease: null,
  task,
  changeRequest: null,
} satisfies BranchSnapshot;

const archived = {
  branch: "feat/parser",
  retiredHead: "0123456789abcdef",
  archiveSessionFile: "/sessions/merged.jsonl",
  archiveSessionId: "archive-session",
  originalSessionFile: "/sessions/original.jsonl",
  trunkWorktreePath: "/worktrees/main",
  task,
  retiredAt: "2026-01-01T00:00:00.000Z",
} satisfies ArchivedSessionBinding;

const lease = {
  leaseId: "lease-1",
  scope: "repository:topology",
  resourceKey: "repo-1",
  operation: "update",
  owner: { kind: "pi-session", id: "session-1", sessionId: "session-1" },
  acquiredAt: "2026-01-01T00:00:00.000Z",
  renewedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T01:00:00.000Z",
} satisfies LeaseSnapshot;

const snapshot = {
  schemaVersion: 1,
  repository,
  refreshedAt: "2026-01-01T00:00:00.000Z",
  branches: [branch],
} satisfies StackSnapshot;

const plan = {
  planId: "plan-1",
  repositoryKey: repository.key,
  kind: "update",
  preconditionToken: "token-1",
  requiresConfirmation: true,
  steps: [
    {
      index: 0,
      effect: "sync_repository",
      branch: "feat/parser",
      worktreePath: "/worktrees/main",
    },
  ],
  warnings: [],
} satisfies OperationPlan;

const result = {
  status: "completed",
  snapshot,
  enteredSessionFile: session.sessionFile,
  conflict: null,
  notices: [],
} satisfies OperationResult;

const active = {
  operationId: "operation-1",
  kind: "restack",
  repositoryKey: "repo-1",
  status: "running",
  steps: [],
  completedStepCount: 0,
  createdArtifacts: [
    {
      kind: "branch",
      identifier: "feat/parser",
      expectedRevision: "0123456789abcdef",
    },
  ],
  expectedHeads: { "feat/parser": "0123456789abcdef" },
  conflictBranch: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies ActiveOperation;

const state = {
  schemaVersion: 1,
  repositoryKey: "repo-1",
  bindings: { "feat/parser": session },
  archivedBindings: [archived],
  activeOperation: active,
} satisfies WorkflowState;

const commandRequest = {
  executable: "/usr/bin/git",
  args: ["status"],
  cwd: "/repo",
  timeoutMs: 1000,
  maxOutputBytes: 1024,
} satisfies CommandRequest;

const commandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  killed: false,
  truncated: false,
} satisfies CommandResult;

const commandRunner = {
  async run(request) {
    void request;
    return commandResult;
  },
} satisfies CommandRunner;

const git = {
  async identify(cwd, signal) {
    void cwd;
    void signal;
    return repository;
  },
  async createBranch(branch, base, cwd, signal) {
    void branch;
    void base;
    void cwd;
    void signal;
  },
  async inspectWorktree(path, signal) {
    void path;
    void signal;
    return { head: "0123456789abcdef", dirty: false, operation: null };
  },
} satisfies GitAdapter;

const spice = {
  async isInitialized(cwd, signal) {
    void cwd;
    void signal;
    return true;
  },
  async readTopology(cwd, includeChangeRequests, signal) {
    void cwd;
    void includeChangeRequests;
    void signal;
    return {
      branches: [
        {
          name: branch.name,
          base: branch.base,
          up: branch.up,
          needsRestack: branch.needsRestack,
          worktreePath: "/worktrees/feat-parser",
          changeRequest: branch.changeRequest,
        },
      ],
    };
  },
  async trackBranch(branch, base, cwd, signal) {
    void branch;
    void base;
    void cwd;
    void signal;
  },
  async restackBranch(branch, worktreePath, signal) {
    void branch;
    void worktreePath;
    void signal;
  },
  async syncRepository(trunkWorktree, signal) {
    void trunkWorktree;
    void signal;
  },
  async submitStack(branch, options, cwd, signal) {
    void branch;
    void options;
    void cwd;
    void signal;
  },
} satisfies GitSpiceAdapter;

const worktrunk = {
  async isAvailable(cwd, signal) {
    void cwd;
    void signal;
    return true;
  },
  async list(cwd, signal) {
    void cwd;
    void signal;
    return [{ branch: "feat/parser", path: "/worktrees/feat-parser", current: true }];
  },
  async ensureWorktree(branch, cwd, signal) {
    void branch;
    void cwd;
    void signal;
    return "/worktrees/feat-parser";
  },
  async removeWorktree(branch, cwd, signal) {
    void branch;
    void cwd;
    void signal;
  },
} satisfies WorktrunkAdapter;

const sessions = {
  async validate(binding) {
    void binding;
    return true;
  },
  async forkCanonical(repository, branch, worktreePath, task) {
    void repository;
    void branch;
    void worktreePath;
    void task;
    return session;
  },
  async archiveToTrunk(input) {
    void input;
    return archived;
  },
  async switchTo(sessionFile) {
    void sessionFile;
    return { cancelled: false };
  },
} satisfies SessionAdapter;

const stateStore = {
  async load(repository) {
    void repository;
    return state;
  },
  async save(repository, state) {
    void repository;
    void state;
  },
} satisfies WorkflowStateStore;

const leases = {
  async acquire(input) {
    void input;
    return lease;
  },
  async renew(lease, ttlMs) {
    void lease;
    void ttlMs;
    return lease;
  },
  async release(lease) {
    void lease;
  },
  async list(repository) {
    void repository;
    return [lease];
  },
} satisfies LeaseStore;

const issueAdapter = {
  provider: "arc",
  async isAvailable(cwd) {
    void cwd;
    return true;
  },
  async resolve(reference, cwd) {
    void reference;
    void cwd;
    return task;
  },
} satisfies IssueAdapter;

const coordinator = {
  async snapshot(signal) {
    void signal;
    return snapshot;
  },
  async plan(request, signal) {
    void request;
    void signal;
    return plan;
  },
  async execute(plan, signal) {
    void plan;
    void signal;
    return result;
  },
} satisfies WorkflowCoordinator;

const _branches: readonly BranchSnapshot[] = snapshot.branches;
const _event: WorkflowEventMap["stack-workflow:snapshot-changed"] = snapshot;

void commandRunner;
void git;
void spice;
void worktrunk;
void sessions;
void stateStore;
void leases;
void issueAdapter;
void coordinator;
void _branches;
void _event;

// @ts-expect-error Raw CLI escape hatches are intentionally unsupported.
const _rawCommand: OperationRequest = { kind: "raw", args: ["--force"] };
void _rawCommand;
