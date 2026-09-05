"""Pinned source-to-Pi transform contracts for the git-spice migration."""

import re

PROMPT_ANCHORS = {
    "commands/continue.md": "Resume — or abort — a git-spice operation that was paused on a rebase conflict.",
    "commands/init.md": "Confirm you're inside a git repository:",
    "commands/new.md": "Create a new branch on top of the current one with `git-spice branch create`.",
    "commands/restack.md": "Rebase one or more branches onto their (current) bases.",
    "commands/stack.md": "Run `git-spice log long` and present the output to the user verbatim",
    "commands/submit.md": "Submit the stack (or a slice of it) as PRs/MRs.",
    "commands/sync.md": "Sync with the remote: pull trunk, delete merged branches, restack survivors.",
}

PROMPT_SAFETY_APPENDICES = {
    "commands/continue.md": (
        "## Pi execution safety\n\n"
        "For unattended continuation, use `git-spice --no-prompt rebase continue --no-edit`. "
        "Interactive commit-message editing is terminal-only; do not open an editor through Pi. "
        "For missing configuration, report it rather than enabling prompts.\n"
    ),
    "commands/init.md": (
        "## Pi execution safety\n\n"
        "Do not run argumentless initialization in Pi. Gather an explicit trunk and remote through an available "
        "user-question tool, or through plain chat when that tool is unavailable; if either value is unavailable, "
        "stop. Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. For `--reset`, disclose that "
        "it forgets all git-spice tracking relationships while leaving Git branches, and obtain a separate explicit "
        "confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.\n"
    ),
    "commands/new.md": (
        "## Pi execution safety\n\n"
        "Gather an explicit branch name and commit message through an available user-question tool or plain chat "
        "before a populated branch creation. Use `git-spice --no-prompt branch create <name> -m <message>` for "
        "populated changes; add `-a` only after explicit approval. On a clean tree, use "
        "`git-spice --no-prompt branch create <name> --no-commit`.\n"
    ),
    "commands/restack.md": (
        "## Pi execution safety\n\n"
        "Execute only an explicit restack scope with `--no-prompt`. If configuration is missing, report it rather "
        "than enabling prompts.\n"
    ),
    "commands/stack.md": (
        "## Pi execution safety\n\n"
        "Inspect with `git-spice --no-prompt log long`; report missing configuration rather than enabling prompts.\n"
    ),
    "commands/submit.md": (
        "## Pi execution safety\n\n"
        "Resolve `--draft` or `--no-draft` from arguments, then `spice.submit.draft`, then an available user-question "
        "tool or plain chat; stop if no value is available. Reject prompt controls and conflicting draft controls "
        "so the resolved draft state remains explicit. Use `git-spice --no-prompt <scope> submit --dry-run --fill "
        "<draft-flag>` first, then `git-spice --no-prompt <scope> submit --fill <draft-flag>`. Documented optional "
        "submit flags may be included only after those checks. The `--update-only` exception applies only when it "
        "proves no new Change Request can be created; otherwise the explicit draft flag is mandatory. Do not enable "
        "prompts for missing configuration.\n"
    ),
    "commands/sync.md": (
        "## Pi execution safety\n\n"
        "Execute `git-spice --no-prompt repo sync --restack`; report missing configuration rather than enabling "
        "prompts.\n"
    ),
}

DISPATCH_CONTRACT = (
    "If the subagent tool is available, list agents first. Dispatch only an executable, non-disabled "
    "git-spice.stacker or git-spice.stack-doctor with fresh context and complete inputs. Never run both against "
    "the same checkout concurrently. If the tool or named agent is unavailable, run the documented direct "
    "workflow instead."
)

REQUIRED_GENERATED_LITERALS = {
    "prompts/git-spice-continue.md": (
        ("git-spice --no-prompt rebase continue --no-edit", 3),
    ),
    "prompts/git-spice-init.md": (
        ("git-spice --no-prompt repo init --trunk=<name> --remote=<name>", 4),
        ("separate explicit confirmation", 1),
    ),
    "prompts/git-spice-new.md": (
        ("git-spice --no-prompt branch create <name> -m <message>", 1),
        ("git-spice --no-prompt branch create <name> --no-commit", 2),
        ("add `-a` only after explicit approval", 1),
    ),
    "prompts/git-spice-submit.md": (
        ("git-spice --no-prompt <scope> submit --dry-run --fill <draft-flag>", 2),
        ("git-spice --no-prompt <scope> submit --fill <draft-flag>", 2),
        ("resolved draft state remains explicit", 2),
    ),
    "prompts/git-spice-sync.md": (
        ("git-spice --no-prompt repo sync --restack", 2),
    ),
    "skills/git-spice/SKILL.md": (
        ("name: git-spice\n", 1),
        ("license: MIT\n", 1),
        (DISPATCH_CONTRACT, 1),
    ),
    "skills/stacking-workflow/SKILL.md": (
        ("name: stacking-workflow\n", 1),
        ("license: MIT\n", 1),
        (DISPATCH_CONTRACT, 1),
    ),
    "agents/stacker.md": (
        ("name: stacker\npackage: git-spice\n", 1),
        ("tools: bash, read, write, edit, find, grep", 1),
        ("inheritProjectContext: true\ndefaultContext: fresh", 1),
        ("<paste final stack log output>", 1),
    ),
    "agents/stack-doctor.md": (
        ("name: stack-doctor\npackage: git-spice\n", 1),
        ("tools: bash, read, find, grep", 1),
        ("inheritProjectContext: true\ndefaultContext: fresh", 1),
        ("<paste final stack log and git status output>", 1),
    ),
}

AGENT_CONFIG = {
    "agents/stacker.md": ("stacker", ["Bash", "Read", "Write", "Edit", "Glob", "Grep"], "## Non-interactive discipline"),
    "agents/stack-doctor.md": ("stack-doctor", ["Bash", "Read", "Glob", "Grep"], "## Diagnosis checklist"),
}
TOOL_MAP = {"Bash": "bash", "Read": "read", "Write": "write", "Edit": "edit", "Glob": "find", "Grep": "grep"}

COMMAND_NAMES = r"(?:repo|auth|log|branch|commit|upstack|downstack|stack|rebase|trunk|top|bottom|up|down|<scope>)"
COMMAND_ANCHOR_PATTERN = re.compile(rf"(?<![\w-])git-spice(?= {COMMAND_NAMES}(?:\s|`|$))")
ALIAS_NAMES = (
    "r", "ls", "ll", "bdi", "bc", "btr", "dstr", "cc", "ca", "csp", "cf", "cp", "bco", "br",
    "usr", "dsr", "sr", "rr", "bsq", "bsp", "be", "bfo", "bon", "uso", "se", "dse", "brn", "bd",
    "sd", "usd", "buntr", "bs", "dss", "uss", "ss", "rs", "rbc", "rba",
)
ALIAS_ANCHOR_PATTERN = re.compile(r"(?<![\w-])git-spice(?= (?:" + "|".join(ALIAS_NAMES) + r")(?:\s|`|\)))")
MUTATION_ANCHOR_PATTERNS = {
    "reset": re.compile(r"git-spice(?: --no-prompt)? repo init(?=[^`\n]*--reset)"),
    "init": re.compile(r"git-spice(?: --no-prompt)? repo init(?![^`\n]*--reset)(?=[\s`])"),
    "branch create": re.compile(r"git-spice(?: --no-prompt)? branch create(?=[\s`])"),
    "rebase continue": re.compile(r"git-spice(?: --no-prompt)? rebase continue(?=[\s`])"),
    "rebase abort": re.compile(r"git-spice(?: --no-prompt)? rebase abort(?=[\s`])"),
    "restack": re.compile(r"git-spice(?: --no-prompt)? (?:branch|upstack|downstack|stack|repo) restack(?=[\s`])"),
    "sync": re.compile(r"git-spice(?: --no-prompt)? repo sync(?=[\s`])"),
    "submit": re.compile(r"git-spice(?: --no-prompt)? (?:branch|upstack|downstack|stack|<scope>) submit(?=[\s`])"),
}
EXPECTED_COMMAND_ANCHORS = {
    "commands/continue.md": 4,
    "commands/init.md": 6,
    "commands/new.md": 5,
    "commands/restack.md": 5,
    "commands/stack.md": 2,
    "commands/submit.md": 4,
    "commands/sync.md": 3,
    "skills/git-spice/SKILL.md": 96,
    "skills/stacking-workflow/SKILL.md": 12,
    "agents/stack-doctor.md": 24,
    "agents/stacker.md": 10,
}
EXPECTED_ALIAS_ANCHORS = {"skills/git-spice/SKILL.md": 40}
EXPECTED_ALIAS_NAMES = {
    "r": 1, "ls": 2, "ll": 2, "bdi": 1, "bc": 1, "btr": 1, "dstr": 1, "cc": 1, "ca": 1,
    "csp": 1, "cf": 1, "cp": 1, "bco": 1, "br": 1, "usr": 1, "dsr": 1, "sr": 1, "rr": 1,
    "bsq": 1, "bsp": 1, "be": 1, "bfo": 1, "bon": 1, "uso": 1, "se": 1, "dse": 1, "brn": 1,
    "bd": 1, "sd": 1, "usd": 1, "buntr": 1, "bs": 1, "dss": 1, "uss": 1, "ss": 1, "rs": 1,
    "rbc": 1, "rba": 1,
}
EXPECTED_MUTATION_ANCHORS = {
    "commands/continue.md": {"rebase continue": 2, "rebase abort": 1},
    "commands/init.md": {"init": 1, "reset": 1},
    "commands/new.md": {"branch create": 4},
    "commands/restack.md": {"restack": 4},
    "commands/submit.md": {"submit": 2},
    "commands/sync.md": {"sync": 1},
    "skills/git-spice/SKILL.md": {"init": 3, "reset": 2, "branch create": 12, "rebase continue": 3, "rebase abort": 2, "restack": 11, "sync": 3, "submit": 8},
    "skills/stacking-workflow/SKILL.md": {"branch create": 1, "rebase continue": 1, "restack": 1, "sync": 1, "submit": 1},
    "agents/stack-doctor.md": {"init": 2, "rebase continue": 3, "restack": 7, "submit": 3},
    "agents/stacker.md": {"branch create": 3, "submit": 2},
}
EDITOR_OPENING_TRANSFORMS = {
    "skills/git-spice/SKILL.md": (
        ("commit create", "git-spice commit create", 'git-spice commit create -m "<message>"', 1),
        ("commit create alias", "git-spice cc", 'git-spice cc -m "<message>"', 1),
        ("commit amend", "git-spice commit amend", "git-spice commit amend --no-edit", 3),
        ("commit amend alias", "git-spice ca", "git-spice ca --no-edit", 1),
        ("branch squash", "git-spice branch squash", "git-spice branch squash --no-edit", 1),
        ("branch squash alias", "git-spice bsq", "git-spice bsq --no-edit", 1),
        (
            "direct commit create alternative",
            "# or commit create —",
            '# or commit create -m "<message>" —',
            1,
        ),
    ),
    "skills/stacking-workflow/SKILL.md": (
        ("commit create", "git-spice commit create", 'git-spice commit create -m "<message>"', 1),
        ("commit amend", "git-spice commit amend", "git-spice commit amend --no-edit", 1),
        (
            "direct commit create alternative",
            "# or 'commit create' for",
            '# or \'commit create -m "<message>"\' for',
            1,
        ),
    ),
}

MANUAL_ONLY = "terminal-only; do not execute via a Pi/tool subprocess."
MANUAL_INTERACTIVE_TRANSFORMS = {
    "commands/init.md": ((
        "4. After init, run `git-spice auth status` and report whether the user is logged in. "
        "If not, suggest `git-spice auth login` — do NOT run it yourself (it's an interactive browser flow).",
        "4. After init, run `git-spice --no-prompt auth status` and report whether the user is logged in. "
        f"If not, suggest `git-spice auth login` — {MANUAL_ONLY}",
    ),),
    "commands/submit.md": ((
        "1. Confirm auth: `git-spice auth status`. If not logged in, stop and instruct the user to run "
        "`git-spice auth login` themselves (interactive). Don't proceed with an unauthenticated submit.",
        "1. Confirm auth: `git-spice --no-prompt auth status`. If not logged in, stop and instruct the user to run "
        f"`git-spice auth login` themselves — {MANUAL_ONLY} Don't proceed with an unauthenticated submit.",
    ),),
    "skills/git-spice/SKILL.md": (
        (
            "| Log in to GitHub/GitLab/Bitbucket | `git-spice auth login` |",
            f"| Log in to GitHub/GitLab/Bitbucket | `git-spice auth login` — {MANUAL_ONLY} |",
        ),
        (
            "| Split a commit interactively | `git-spice commit split` (`git-spice csp`) |",
            f"| Split a commit interactively | `git-spice commit split` (`git-spice csp`) — {MANUAL_ONLY} |",
        ),
        (
            "| Split this branch at chosen commits | `git-spice branch split` (`git-spice bsp`) |",
            f"| Split this branch at chosen commits | `git-spice branch split` (`git-spice bsp`) — {MANUAL_ONLY} |",
        ),
        (
            "| Interactively edit/reorder this branch's commits | `git-spice branch edit` (`git-spice be`) "
            "— interactive; restacks upstack after |",
            "| Interactively edit/reorder this branch's commits | `git-spice branch edit` (`git-spice be`) — "
            f"{MANUAL_ONLY} Restacks upstack after. |",
        ),
        (
            "| Reorder branches in the stack | `git-spice stack edit` (`git-spice se`) — interactive |",
            f"| Reorder branches in the stack | `git-spice stack edit` (`git-spice se`) — {MANUAL_ONLY} |",
        ),
        (
            "| Reorder branches below the current one | `git-spice downstack edit` (`git-spice dse`) — interactive |",
            "| Reorder branches below the current one | `git-spice downstack edit` (`git-spice dse`) — "
            f"{MANUAL_ONLY} |",
        ),
        (
            "- **Don't `git rebase` inside a stack** without going through git-spice. You'll desync the recorded bases. "
            "Use `git-spice upstack restack`, or `git-spice branch edit` when the user is driving interactively.",
            "- **Don't `git rebase` inside a stack** without going through git-spice. You'll desync the recorded bases. "
            f"Use `git-spice --no-prompt upstack restack`, or `git-spice branch edit` — {MANUAL_ONLY}",
        ),
    ),
    "skills/stacking-workflow/SKILL.md": ((
        '- **"A branch grew too big and needs splitting."** Sizing problem. `git-spice branch split` '
        "at chosen commits (interactive — hand it to the user in unattended runs).",
        '- **"A branch grew too big and needs splitting."** Sizing problem. `git-spice branch split` '
        f"at chosen commits — {MANUAL_ONLY}",
    ),),
    "agents/stack-doctor.md": ((
        "| Submit errors with auth message | token expired or scope insufficient | `git-spice auth login` "
        "(user must run interactively) |",
        "| Submit errors with auth message | token expired or scope insufficient | `git-spice auth login` — "
        f"{MANUAL_ONLY} |",
    ),),
}

SUBMIT_DRAFT_CONTRACT = (
    "## Explicit submit draft state\n\n"
    "Before every create-capable direct submit workflow, resolve draft state from an explicit argument, then "
    "`spice.submit.draft`, then a Pi user-question tool or plain chat. Execute with an explicit `<draft-flag>` "
    "chosen as `--draft` or `--no-draft`; never rely on an implicit draft state. The `--update-only` exception "
    "applies only when that flag proves no new Change Request can be created; otherwise never omit the draft flag.\n"
)
INIT_SAFETY_CONTRACT = (
    "## Explicit initialization and reset safety\n\n"
    "For every initialization, reconfiguration, or recovery path, gather both trunk and remote from explicit "
    "arguments, a Pi user-question tool, or plain chat. Always run `git-spice --no-prompt repo init "
    "--trunk=<name> --remote=<name>`. A reset forgets all git-spice tracking relationships while leaving Git "
    "branches; disclose that impact and require a separate explicit confirmation before running `git-spice "
    "--no-prompt repo init --trunk=<name> --remote=<name> --reset`.\n"
)
