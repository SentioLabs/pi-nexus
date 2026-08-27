import type {
  ActiveOperation,
  ArchivedSessionBinding,
  BranchSnapshot,
  OperationRequest,
  StackSnapshot,
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
  session: null,
  lease: null,
  task: null,
  changeRequest: null,
} satisfies BranchSnapshot;

const archived = {
  branch: "feat/parser",
  retiredHead: "0123456789abcdef",
  archiveSessionFile: "/sessions/merged.jsonl",
  archiveSessionId: "archive-session",
  originalSessionFile: "/sessions/original.jsonl",
  trunkWorktreePath: "/worktrees/main",
  task: { provider: "arc", id: "pinexus-123" },
  retiredAt: "2026-01-01T00:00:00.000Z",
} satisfies ArchivedSessionBinding;

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
  bindings: {},
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

declare const snapshot: StackSnapshot;
declare const commandRunner: CommandRunner;
declare const git: GitAdapter;
declare const spice: GitSpiceAdapter;
declare const worktrunk: WorktrunkAdapter;
declare const sessions: SessionAdapter;
declare const stateStore: WorkflowStateStore;
declare const leases: LeaseStore;
declare const issueAdapter: IssueAdapter;
declare const coordinator: WorkflowCoordinator;

const _branches: readonly BranchSnapshot[] = snapshot.branches;
const _plan: ReturnType<WorkflowCoordinator["plan"]> = coordinator.plan(request);
const _commandRunner: CommandRunner = commandRunner;
const _git: GitAdapter = git;
const _spice: GitSpiceAdapter = spice;
const _worktrunk: WorktrunkAdapter = worktrunk;
const _sessions: SessionAdapter = sessions;
const _stateStore: WorkflowStateStore = stateStore;
const _leases: LeaseStore = leases;
const _issueAdapter: IssueAdapter = issueAdapter;
const _event: WorkflowEventMap["stack-workflow:snapshot-changed"] = snapshot;

void branch;
void archived;
void active;
void state;
void commandRequest;
void commandResult;
void _branches;
void _plan;
void _commandRunner;
void _git;
void _spice;
void _worktrunk;
void _sessions;
void _stateStore;
void _leases;
void _issueAdapter;
void _event;

// @ts-expect-error Raw CLI escape hatches are intentionally unsupported.
const _rawCommand: OperationRequest = { kind: "raw", args: ["--force"] };
void _rawCommand;
