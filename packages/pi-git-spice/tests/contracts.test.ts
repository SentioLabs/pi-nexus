import type {
  ActiveOperation,
  ArchivedSessionBinding,
  BranchSnapshot,
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

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends
  (<Value>() => Value extends Expected ? 1 : 2)
    ? (<Value>() => Value extends Expected ? 1 : 2) extends
      (<Value>() => Value extends Actual ? 1 : 2)
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;

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

const enterRequest = {
  kind: "enter",
  branch: "feat/parser",
  createWorktree: true,
} satisfies OperationRequest;

const prepareBranchRequest = {
  kind: "prepare_branch",
  branch: "feat/parser",
  base: "main",
  task,
} satisfies OperationRequest;

const restackRequest = {
  kind: "restack",
  branch: null,
} satisfies OperationRequest;

const updateRequest = {
  kind: "update",
  branch: "feat/parser",
} satisfies OperationRequest;

const submitRequest = {
  kind: "submit",
  branch: "feat/parser",
  draft: true,
  fillFromCommits: true,
} satisfies OperationRequest;

const continueRestackRequest = {
  kind: "continue_restack",
  branch: "feat/parser",
} satisfies OperationRequest;

const abortRestackRequest = {
  kind: "abort_restack",
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

type _CommandRunnerRun = Expect<
  Equal<CommandRunner["run"], (request: CommandRequest) => Promise<CommandResult>>
>;
type _GitIdentify = Expect<
  Equal<GitAdapter["identify"], (cwd: string, signal?: AbortSignal) => Promise<RepositoryIdentity>>
>;
type _GitCreateBranch = Expect<
  Equal<
    GitAdapter["createBranch"],
    (branch: string, base: string, cwd: string, signal?: AbortSignal) => Promise<void>
  >
>;
type _GitInspectWorktree = Expect<
  Equal<
    GitAdapter["inspectWorktree"],
    (path: string, signal?: AbortSignal) => Promise<{
      readonly head: string;
      readonly dirty: boolean;
      readonly operation: "rebase" | "merge" | "cherry-pick" | "revert" | null;
    }>
  >
>;
type _GitSpiceIsInitialized = Expect<
  Equal<GitSpiceAdapter["isInitialized"], (cwd: string, signal?: AbortSignal) => Promise<boolean>>
>;
type _GitSpiceReadTopology = Expect<
  Equal<
    GitSpiceAdapter["readTopology"],
    (
      cwd: string,
      includeChangeRequests: boolean,
      signal?: AbortSignal,
    ) => Promise<{
      readonly branches: readonly {
        readonly name: string;
        readonly base: string | null;
        readonly up: readonly string[];
        readonly needsRestack: boolean;
        readonly worktreePath: string | null;
        readonly changeRequest: ChangeRequestSnapshot | null;
      }[];
    }>
  >
>;
type _GitSpiceTrackBranch = Expect<
  Equal<
    GitSpiceAdapter["trackBranch"],
    (branch: string, base: string, cwd: string, signal?: AbortSignal) => Promise<void>
  >
>;
type _GitSpiceRestackBranch = Expect<
  Equal<
    GitSpiceAdapter["restackBranch"],
    (branch: string, worktreePath: string, signal?: AbortSignal) => Promise<void>
  >
>;
type _GitSpiceSyncRepository = Expect<
  Equal<GitSpiceAdapter["syncRepository"], (trunkWorktree: string, signal?: AbortSignal) => Promise<void>>
>;
type _GitSpiceSubmitStack = Expect<
  Equal<
    GitSpiceAdapter["submitStack"],
    (
      branch: string | null,
      options: { readonly draft: boolean; readonly fillFromCommits: boolean },
      cwd: string,
      signal?: AbortSignal,
    ) => Promise<void>
  >
>;
type _WorktrunkIsAvailable = Expect<
  Equal<WorktrunkAdapter["isAvailable"], (cwd: string, signal?: AbortSignal) => Promise<boolean>>
>;
type _WorktrunkList = Expect<
  Equal<
    WorktrunkAdapter["list"],
    (
      cwd: string,
      signal?: AbortSignal,
    ) => Promise<readonly { readonly branch: string | null; readonly path: string; readonly current: boolean }[]>
  >
>;
type _WorktrunkEnsureWorktree = Expect<
  Equal<
    WorktrunkAdapter["ensureWorktree"],
    (branch: string, cwd: string, signal?: AbortSignal) => Promise<string>
  >
>;
type _WorktrunkRemoveWorktree = Expect<
  Equal<
    WorktrunkAdapter["removeWorktree"],
    (branch: string, cwd: string, signal?: AbortSignal) => Promise<void>
  >
>;
type _SessionValidate = Expect<Equal<SessionAdapter["validate"], (binding: SessionBinding) => Promise<boolean>>>;
type _SessionForkCanonical = Expect<
  Equal<
    SessionAdapter["forkCanonical"],
    (
      repository: RepositoryIdentity,
      branch: string,
      worktreePath: string,
      task: TaskReference | null,
    ) => Promise<SessionBinding>
  >
>;
type _SessionArchiveToTrunk = Expect<
  Equal<
    SessionAdapter["archiveToTrunk"],
    (input: {
      readonly binding: SessionBinding;
      readonly retiredHead: string;
      readonly trunkWorktreePath: string;
    }) => Promise<ArchivedSessionBinding>
  >
>;
type _SessionSwitchTo = Expect<
  Equal<SessionAdapter["switchTo"], (sessionFile: string) => Promise<{ readonly cancelled: boolean }>>
>;
type _WorkflowStateStoreLoad = Expect<
  Equal<WorkflowStateStore["load"], (repository: RepositoryIdentity) => Promise<WorkflowState>>
>;
type _WorkflowStateStoreSave = Expect<
  Equal<
    WorkflowStateStore["save"],
    (repository: RepositoryIdentity, state: WorkflowState) => Promise<void>
  >
>;
type _LeaseStoreAcquire = Expect<
  Equal<
    LeaseStore["acquire"],
    (input: {
      readonly repository: RepositoryIdentity;
      readonly scope: LeaseScope;
      readonly resourceKey: string;
      readonly operation: string;
      readonly owner: LeaseOwner;
      readonly ttlMs: number;
    }) => Promise<LeaseSnapshot>
  >
>;
type _LeaseStoreRenew = Expect<
  Equal<LeaseStore["renew"], (lease: LeaseSnapshot, ttlMs: number) => Promise<LeaseSnapshot>>
>;
type _LeaseStoreRelease = Expect<Equal<LeaseStore["release"], (lease: LeaseSnapshot) => Promise<void>>>;
type _LeaseStoreList = Expect<
  Equal<LeaseStore["list"], (repository: RepositoryIdentity) => Promise<readonly LeaseSnapshot[]>>
>;
type _IssueAdapterProvider = Expect<Equal<IssueAdapter["provider"], string>>;
type _IssueAdapterIsAvailable = Expect<Equal<IssueAdapter["isAvailable"], (cwd: string) => Promise<boolean>>>;
type _IssueAdapterResolve = Expect<
  Equal<
    IssueAdapter["resolve"],
    (reference: TaskReference, cwd: string) => Promise<TaskReference | null>
  >
>;
type _WorkflowCoordinatorSnapshot = Expect<
  Equal<WorkflowCoordinator["snapshot"], (signal?: AbortSignal) => Promise<StackSnapshot>>
>;
type _WorkflowCoordinatorPlan = Expect<
  Equal<
    WorkflowCoordinator["plan"],
    (request: OperationRequest, signal?: AbortSignal) => Promise<OperationPlan>
  >
>;
type _WorkflowCoordinatorExecute = Expect<
  Equal<
    WorkflowCoordinator["execute"],
    (plan: OperationPlan, signal?: AbortSignal) => Promise<OperationResult>
  >
>;

const _branches: readonly BranchSnapshot[] = snapshot.branches;
const _event: WorkflowEventMap["stack-workflow:snapshot-changed"] = snapshot;

void enterRequest;
void prepareBranchRequest;
void restackRequest;
void updateRequest;
void submitRequest;
void continueRestackRequest;
void abortRestackRequest;
void state;
void commandRequest;
void commandResult;
void _branches;
void _event;

// @ts-expect-error Raw CLI escape hatches are intentionally unsupported.
const _rawCommand: OperationRequest = { kind: "raw", args: ["--force"] };
void _rawCommand;
