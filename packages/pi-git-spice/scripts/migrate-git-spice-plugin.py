#!/usr/bin/env python3
"""Regenerate Pi git-spice resources from the Claude plugin source."""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import shlex
import shutil
import tempfile

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_CANDIDATES = (
    Path.home() / "devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/git-spice",
)

RUNTIME_MANIFEST = (
    ("commands/continue.md", "prompts/git-spice-continue.md"),
    ("commands/init.md", "prompts/git-spice-init.md"),
    ("commands/new.md", "prompts/git-spice-new.md"),
    ("commands/restack.md", "prompts/git-spice-restack.md"),
    ("commands/stack.md", "prompts/git-spice-stack.md"),
    ("commands/submit.md", "prompts/git-spice-submit.md"),
    ("commands/sync.md", "prompts/git-spice-sync.md"),
    ("skills/git-spice/SKILL.md", "skills/git-spice/SKILL.md"),
    ("skills/stacking-workflow/SKILL.md", "skills/stacking-workflow/SKILL.md"),
    ("agents/stack-doctor.md", "agents/stack-doctor.md"),
    ("agents/stacker.md", "agents/stacker.md"),
)

SOURCE_METADATA_PATH = ".claude-plugin/plugin.json"
INTENTIONALLY_IGNORED_SOURCE_PATHS = ("CHANGELOG.md", "version.txt")
REQUIRED_SOURCE_PATHS = tuple(source for source, _ in RUNTIME_MANIFEST) + (SOURCE_METADATA_PATH,)
GENERATED_ROOTS = tuple(sorted({Path(target).parts[0] for _, target in RUNTIME_MANIFEST}))
FORBIDDEN_GENERATED = (
    "/git-spice:",
    "subagent_type",
    "model: sonnet",
    "  - Bash\n",
    "  - Read\n",
    "  - Write\n",
    "  - Edit\n",
    "  - Glob\n",
    "  - Grep\n",
)

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
    "commands/continue.md": """## Pi execution safety

For unattended continuation, use `git-spice --no-prompt rebase continue --no-edit`. Interactive commit-message editing is terminal-only; do not open an editor through Pi. For missing configuration, report it rather than enabling prompts.
""",
    "commands/init.md": """## Pi execution safety

Do not run argumentless initialization in Pi. Gather an explicit trunk and remote through an available user-question tool, or through plain chat when that tool is unavailable; if either value is unavailable, stop. Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. For `--reset`, disclose that it forgets all git-spice tracking relationships while leaving Git branches, and obtain a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.
""",
    "commands/new.md": """## Pi execution safety

Gather an explicit branch name and commit message through an available user-question tool or plain chat before a populated branch creation. Use `git-spice --no-prompt branch create <name> -m <message>` for populated changes; add `-a` only after explicit approval. On a clean tree, use `git-spice --no-prompt branch create <name> --no-commit`.
""",
    "commands/restack.md": """## Pi execution safety

Execute only an explicit restack scope with `--no-prompt`. If configuration is missing, report it rather than enabling prompts.
""",
    "commands/stack.md": """## Pi execution safety

Inspect with `git-spice --no-prompt log long`; report missing configuration rather than enabling prompts.
""",
    "commands/submit.md": """## Pi execution safety

Resolve `--draft` or `--no-draft` from arguments, then `spice.submit.draft`, then an available user-question tool or plain chat; stop if no value is available. Use the resolved flag for both `git-spice --no-prompt <scope> submit --dry-run --fill <draft-flag>` and `git-spice --no-prompt <scope> submit --fill <draft-flag> <extra-flags>`. The `--update-only` exception applies only when it proves no new Change Request can be created; otherwise the explicit draft flag is mandatory. Do not enable prompts for missing configuration.
""",
    "commands/sync.md": """## Pi execution safety

Execute `git-spice --no-prompt repo sync --restack`; report missing configuration rather than enabling prompts.
""",
}

DISPATCH_CONTRACT = """If the subagent tool is available, list agents first. Dispatch only an executable, non-disabled git-spice.stacker or git-spice.stack-doctor with fresh context and complete inputs. Never run both against the same checkout concurrently. If the tool or named agent is unavailable, run the documented direct workflow instead."""

AGENT_CONFIG = {
    "agents/stacker.md": ("stacker", ["Bash", "Read", "Write", "Edit", "Glob", "Grep"], "## Non-interactive discipline"),
    "agents/stack-doctor.md": ("stack-doctor", ["Bash", "Read", "Glob", "Grep"], "## Diagnosis checklist"),
}
TOOL_MAP = {"Bash": "bash", "Read": "read", "Write": "write", "Edit": "edit", "Glob": "find", "Grep": "grep"}

GLOBAL_FLAG_OPTIONS = {
    "-h",
    "--help",
    "-v",
    "--verbose",
    "--no-prompt",
    "--prompt",
    "--version",
}
GLOBAL_VALUE_OPTIONS = {"-C", "--dir"}

READ_ONLY_COMMAND_SIGNATURES = {
    ("auth", "status"),
    ("log", "short"),
    ("log", "long"),
    ("branch", "diff"),
    ("ls",),
    ("ll",),
    ("bdi",),
}
MUTATING_COMMAND_SIGNATURES = {
    ("repo", "init"),
    ("repo", "restack"),
    ("repo", "sync"),
    ("auth", "login"),
    ("auth", "logout"),
    ("branch", "create"),
    ("branch", "track"),
    ("branch", "checkout"),
    ("branch", "restack"),
    ("branch", "squash"),
    ("branch", "split"),
    ("branch", "edit"),
    ("branch", "fold"),
    ("branch", "onto"),
    ("branch", "rename"),
    ("branch", "delete"),
    ("branch", "untrack"),
    ("branch", "submit"),
    ("commit", "create"),
    ("commit", "amend"),
    ("commit", "split"),
    ("commit", "fixup"),
    ("commit", "pick"),
    ("commit", "..."),
    ("upstack", "restack"),
    ("upstack", "onto"),
    ("upstack", "delete"),
    ("upstack", "submit"),
    ("downstack", "track"),
    ("downstack", "restack"),
    ("downstack", "edit"),
    ("downstack", "submit"),
    ("stack", "restack"),
    ("stack", "edit"),
    ("stack", "delete"),
    ("stack", "submit"),
    ("rebase", "continue"),
    ("rebase", "abort"),
    ("<scope>", "submit"),
    ("trunk",),
    ("top",),
    ("bottom",),
    ("up",),
    ("down",),
    ("r", "i"),
    ("bc",),
    ("btr",),
    ("dstr",),
    ("cc",),
    ("ca",),
    ("csp",),
    ("cf",),
    ("cp",),
    ("bco",),
    ("br",),
    ("usr",),
    ("dsr",),
    ("sr",),
    ("rr",),
    ("bsq",),
    ("bsp",),
    ("be",),
    ("bfo",),
    ("bon",),
    ("uso",),
    ("se",),
    ("dse",),
    ("brn",),
    ("bd",),
    ("sd",),
    ("usd",),
    ("buntr",),
    ("bs",),
    ("dss",),
    ("uss",),
    ("ss",),
    ("rs",),
    ("rbc",),
    ("rba",),
}

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

SUBMIT_DRAFT_CONTRACT = """## Explicit submit draft state

Before every create-capable direct submit workflow, resolve draft state from an explicit argument, then `spice.submit.draft`, then a Pi user-question tool or plain chat. Execute with an explicit `<draft-flag>` chosen as `--draft` or `--no-draft`; never rely on an implicit draft state. The `--update-only` exception applies only when that flag proves no new Change Request can be created; otherwise never omit the draft flag.
"""
INIT_SAFETY_CONTRACT = """## Explicit initialization and reset safety

For every initialization, reconfiguration, or recovery path, gather both trunk and remote from explicit arguments, a Pi user-question tool, or plain chat. Always run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. A reset forgets all git-spice tracking relationships while leaving Git branches; disclose that impact and require a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Regenerate Pi git-spice resources from the Claude git-spice plugin source.")
    parser.add_argument("source", nargs="?", help="Path to the Claude git-spice plugin source.")
    parser.add_argument("--source", dest="source_option", metavar="SOURCE", help="Source path (option form).")
    return parser.parse_args()


def resolve_source_path(args: argparse.Namespace) -> Path:
    if args.source and args.source_option:
        raise SystemExit("Pass the source path either positionally or with --source, not both.")
    raw = args.source_option or args.source
    if raw:
        return Path(raw).expanduser().resolve()
    return next((candidate.expanduser().resolve() for candidate in DEFAULT_SOURCE_CANDIDATES if candidate.exists()), DEFAULT_SOURCE_CANDIDATES[0].expanduser().resolve())


def reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError(f"Duplicate JSON key in source plugin.json: {key!r}")
        result[key] = value
    return result


def validate_metadata(source: Path) -> None:
    metadata_path = source / SOURCE_METADATA_PATH
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf8"), object_pairs_hook=reject_duplicate_json_keys)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Invalid source plugin.json at {metadata_path}: {error}") from error
    if not isinstance(metadata, dict):
        raise RuntimeError(f"Invalid source plugin.json at {metadata_path}: expected an object")
    required = {"name", "description", "version", "author", "repository", "homepage", "license", "keywords"}
    if set(metadata) != required:
        missing = sorted(required - set(metadata))
        unknown = sorted(set(metadata) - required)
        raise RuntimeError(f"Source plugin.json fields must exactly match the supported schema; missing={missing!r}, unknown={unknown!r}: {metadata_path}")
    for key in ("name", "description", "version", "repository", "homepage", "license"):
        if not isinstance(metadata[key], str) or not metadata[key].strip():
            raise RuntimeError(f"Source plugin.json {key} must be a non-empty string: {metadata_path}")
    if metadata["name"] != "git-spice":
        raise RuntimeError(f"Source plugin.json name must be 'git-spice', got {metadata['name']!r}: {metadata_path}")
    if metadata["license"] != "MIT":
        raise RuntimeError(f"Source plugin.json license must be 'MIT', got {metadata['license']!r}: {metadata_path}")
    author = metadata["author"]
    if not isinstance(author, dict) or set(author) != {"name", "url"} or not all(isinstance(author[key], str) and author[key].strip() for key in author):
        raise RuntimeError(f"Source plugin.json author must have non-empty string name and url fields: {metadata_path}")
    if not isinstance(metadata["keywords"], list) or not all(isinstance(keyword, str) and keyword.strip() for keyword in metadata["keywords"]):
        raise RuntimeError(f"Source plugin.json keywords must be a string array of non-empty values: {metadata_path}")


def validate_source(source: Path) -> None:
    missing = [relative for relative in REQUIRED_SOURCE_PATHS if not (source / relative).is_file()]
    if missing:
        raise RuntimeError("Source plugin does not look like the Claude git-spice plugin:\nMissing expected paths:\n" + "\n".join(f"- {path}" for path in missing))
    expected = set(REQUIRED_SOURCE_PATHS) | set(INTENTIONALLY_IGNORED_SOURCE_PATHS)
    actual = {path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()}
    unclassified = sorted(actual - expected)
    if unclassified:
        raise RuntimeError("Unclassified source file(s) would be omitted from pi-git-spice generation:\n" + "\n".join(f"- {path}" for path in unclassified))
    validate_metadata(source)
    for source_relative, _ in RUNTIME_MANIFEST:
        text = (source / source_relative).read_text(encoding="utf8")
        if source_relative.startswith("commands/"):
            parse_prompt_frontmatter(text, source_relative)
        elif source_relative.startswith("skills/"):
            validate_skill_frontmatter(text, Path(source_relative).parts[1], source_relative)
        else:
            _, expected_tools, _ = AGENT_CONFIG[source_relative]
            parse_agent_frontmatter(text, expected_tools, source_relative)


def require_replace(text: str, old: str, new: str, context: str) -> str:
    occurrences = text.count(old)
    if occurrences != 1:
        raise RuntimeError(f"Expected exactly one source text occurrence while patching {context}, found {occurrences}: {old[:120]!r}")
    return text.replace(old, new, 1)


def replace_all(text: str, old: str, new: str, context: str, require_match: bool = True) -> str:
    occurrences = text.count(old)
    if not occurrences and require_match:
        raise RuntimeError(f"Expected source text not found while patching {context}: {old[:120]!r}")
    result = text.replace(old, new)
    if old in result:
        raise RuntimeError(f"Source text remained after lexical replacement in {context}: {old[:120]!r}")
    return result


def checked_sub(pattern: re.Pattern[str], replacement, text: str, expected: int, context: str, label: str) -> str:
    occurrences = len(pattern.findall(text))
    if occurrences != expected:
        raise RuntimeError(f"Expected exactly {expected} {label} while patching {context}, found {occurrences}")
    result, substitutions = pattern.subn(replacement, text)
    if substitutions != expected:
        raise RuntimeError(f"Failed checked substitution for {label} while patching {context}: expected {expected}, replaced {substitutions}")
    return result


def validate_transformation_anchors(text: str, context: str) -> None:
    expected_mutations = EXPECTED_MUTATION_ANCHORS.get(context, {})
    for label in ("reset", "init", "branch create", "rebase continue", "rebase abort", "restack", "sync", "submit"):
        expected = expected_mutations.get(label, 0)
        actual = len(MUTATION_ANCHOR_PATTERNS[label].findall(text))
        if actual != expected:
            raise RuntimeError(f"Expected exactly {expected} {label} mutation anchor cardinality while patching {context}, found {actual}")
    expected_aliases = EXPECTED_ALIAS_ANCHORS.get(context, 0)
    aliases = len(ALIAS_ANCHOR_PATTERN.findall(text))
    if aliases != expected_aliases:
        raise RuntimeError(f"Expected exactly {expected_aliases} alias command anchor cardinality while patching {context}, found {aliases}")
    if context == "skills/git-spice/SKILL.md":
        for alias, expected in EXPECTED_ALIAS_NAMES.items():
            pattern = re.compile(rf"(?<![\w-])git-spice {re.escape(alias)}(?=\s|`|\))")
            actual = len(pattern.findall(text))
            if actual != expected:
                raise RuntimeError(f"Expected exactly {expected} {alias!r} alias command anchor cardinality while patching {context}, found {actual}")
    expected_commands = EXPECTED_COMMAND_ANCHORS[context]
    commands = len(COMMAND_ANCHOR_PATTERN.findall(text))
    if commands != expected_commands:
        raise RuntimeError(f"Expected exactly {expected_commands} command anchor cardinality while patching {context}, found {commands}")


def split_frontmatter(text: str, context: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        raise RuntimeError(f"Expected opening frontmatter delimiter while patching {context}")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise RuntimeError(f"Expected closing frontmatter delimiter while patching {context}")
    return text[4:end], text[end + 5:].lstrip("\n")


def scalar_fields(frontmatter: str, allowed: set[str], context: str, type_name: str) -> list[tuple[str, str]]:
    fields = []
    seen = set()
    for line in frontmatter.splitlines():
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*): (.+)", line)
        if not match or match.group(2) in {">", "|"}:
            raise RuntimeError(f"Unsupported source {type_name} frontmatter shape while patching {context}: {line!r}")
        key, value = match.groups()
        if key in seen:
            raise RuntimeError(f"Duplicate source {type_name} frontmatter key while patching {context}: {key!r}")
        if key not in allowed:
            raise RuntimeError(f"Unsupported source {type_name} frontmatter key while patching {context}: {key!r}")
        seen.add(key)
        fields.append((key, value.strip()))
    return fields


def parse_prompt_frontmatter(text: str, context: str) -> tuple[list[tuple[str, str]], str]:
    frontmatter, body = split_frontmatter(text, context)
    fields = scalar_fields(frontmatter, {"description", "argument-hint"}, context, "prompt")
    values = dict(fields)
    if "description" not in values or not values["description"]:
        raise RuntimeError(f"Source prompt description is required and non-empty while patching {context}")
    if "argument-hint" in values and not values["argument-hint"]:
        raise RuntimeError(f"Source prompt argument-hint must be non-empty while patching {context}")
    return fields, body


def validate_skill_frontmatter(text: str, expected_name: str, context: str) -> str:
    frontmatter, body = split_frontmatter(text, context)
    fields = scalar_fields(frontmatter, {"name", "description", "license"}, context, "skill")
    values = dict(fields)
    if values.get("name") != expected_name:
        raise RuntimeError(f"Source skill name must be {expected_name!r} while patching {context}")
    if not values.get("description"):
        raise RuntimeError(f"Source skill description is required and non-empty while patching {context}")
    if "license" in values and values["license"] != "MIT":
        raise RuntimeError(f"Source skill license must be 'MIT' while patching {context}")
    return "---\nname: " + expected_name + "\ndescription: >\n  " + values["description"] + "\nlicense: MIT\n---\n\n" + body


def parse_agent_frontmatter(text: str, expected_source_tools: list[str], context: str) -> tuple[str, list[str], str]:
    frontmatter, body = split_frontmatter(text, context)
    top_level = []
    tool_lines = []
    current_key = None
    for line in frontmatter.splitlines():
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):(?: (.*))?", line)
        if match:
            current_key = match.group(1)
            top_level.append((current_key, match.group(2)))
            continue
        if line.startswith("  - "):
            if current_key != "tools":
                raise RuntimeError(f"List item outside source agent tools block while patching {context}: {line!r}")
            if not re.fullmatch(r"  - \S(?:.*\S)?", line):
                raise RuntimeError(f"Malformed source agent tool or unsupported source agent frontmatter shape while patching {context}")
            tool_lines.append(line)
            continue
        raise RuntimeError(f"Unsupported source agent frontmatter shape while patching {context}: {line!r}")
    keys = [key for key, _ in top_level]
    for key in keys:
        if keys.count(key) > 1:
            raise RuntimeError(f"Duplicate source agent frontmatter key while patching {context}: {key!r}")
    allowed = {"description", "tools", "model"}
    unknown = sorted(set(keys) - allowed)
    missing = sorted(allowed - set(keys))
    if unknown:
        raise RuntimeError(f"Unsupported source agent frontmatter key while patching {context}: {unknown[0]!r}")
    if missing:
        raise RuntimeError(f"Source agent frontmatter fields must exactly match the supported schema; missing={missing!r}, unknown=[] while patching {context}")
    if keys != ["description", "tools", "model"]:
        raise RuntimeError(f"Unsupported source agent frontmatter shape while patching {context}")
    description_value = top_level[0][1]
    if description_value is None or not description_value.strip():
        raise RuntimeError(f"Source agent description must be a non-empty scalar while patching {context}")
    if top_level[1][1] is not None:
        raise RuntimeError(f"Source agent tools must be a block list while patching {context}")
    model = top_level[2][1]
    if model != "sonnet":
        raise RuntimeError(f"Source agent model must be exactly 'model: sonnet' while patching {context}")
    if not tool_lines:
        raise RuntimeError(f"Malformed source agent tool or unsupported source agent frontmatter shape while patching {context}")
    tools = [line.removeprefix("  - ").strip() for line in tool_lines]
    if tools != expected_source_tools:
        raise RuntimeError(f"Source agent tools must exactly match {expected_source_tools!r} while patching {context}")
    if len(set(tools)) != len(tools):
        raise RuntimeError(f"Duplicate source agent tool while patching {context}")
    return description_value.strip(), tools, body


def render_prompt(fields: list[tuple[str, str]], body: str) -> str:
    return "---\n" + "\n".join(f"{key}: {value}" for key, value in fields) + "\n---\n\n" + body.rstrip() + "\n"


def transform_prompt_references(body: str, context: str) -> str:
    references = re.findall(r"/git-spice:([A-Za-z0-9][A-Za-z0-9-]*)", body)
    if "/git-spice:" in body and not references:
        raise RuntimeError(f"Malformed /git-spice reference while patching {context}")
    for name in sorted(set(references)):
        source_reference = f"/git-spice:{name}"
        target_reference = f"/git-spice-{name}"
        source_count = body.count(source_reference)
        body = replace_all(body, source_reference, target_reference, context)
        if body.count(source_reference) or body.count(target_reference) < source_count:
            raise RuntimeError(f"Failed to preserve /git-spice reference cardinality while patching {context}: {source_reference!r}")
    return body


def make_commands_noninteractive(text: str, context: str) -> str:
    text = checked_sub(
        COMMAND_ANCHOR_PATTERN,
        "git-spice --no-prompt",
        text,
        EXPECTED_COMMAND_ANCHORS[context],
        context,
        "command prefixes",
    )
    return checked_sub(
        ALIAS_ANCHOR_PATTERN,
        "git-spice --no-prompt",
        text,
        EXPECTED_ALIAS_ANCHORS.get(context, 0),
        context,
        "alias command prefixes",
    )


def make_alias_mutations_explicit(text: str, context: str) -> str:
    if context != "skills/git-spice/SKILL.md":
        return text
    replacements = (
        (r"git-spice --no-prompt r i(?=`|\))", "git-spice --no-prompt r i --trunk=<name> --remote=<name>", "repo init alias"),
        (r"git-spice --no-prompt bc(?=`|\))", 'git-spice --no-prompt bc <name> -m "<message>"', "branch create alias"),
        (r"git-spice --no-prompt rbc(?=`|\))", "git-spice --no-prompt rbc --no-edit", "rebase continue alias"),
        (r"git-spice --no-prompt rs(?=`|\))", "git-spice --no-prompt rs --restack", "repo sync alias"),
        (r"git-spice --no-prompt bs(?=`|\))", "git-spice --no-prompt bs <draft-flag>", "branch submit alias"),
        (r"git-spice --no-prompt dss(?=`|\))", "git-spice --no-prompt dss <draft-flag>", "downstack submit alias"),
        (r"git-spice --no-prompt uss(?=`|\))", "git-spice --no-prompt uss <draft-flag>", "upstack submit alias"),
        (r"git-spice --no-prompt ss(?=`|\))", "git-spice --no-prompt ss <draft-flag>", "stack submit alias"),
    )
    for source_pattern, replacement, label in replacements:
        text = checked_sub(re.compile(source_pattern), replacement, text, 1, context, label)
    return text


def make_rebase_continuations_noninteractive(text: str, context: str) -> str:
    expected = EXPECTED_MUTATION_ANCHORS.get(context, {}).get("rebase continue", 0)
    pattern = re.compile(r"git-spice --no-prompt rebase continue(?!\s+--no-edit)")
    return checked_sub(pattern, "git-spice --no-prompt rebase continue --no-edit", text, expected, context, "rebase continue mutations")


def split_command_comment(arguments: str) -> tuple[str, str]:
    marker = arguments.find("#")
    if marker == -1 or (marker > 0 and not arguments[marker - 1].isspace()):
        return arguments.strip(), ""
    return arguments[:marker].strip(), " # " + arguments[marker + 1:].strip()


def make_branch_creations_explicit(text: str, context: str) -> str:
    expected = EXPECTED_MUTATION_ANCHORS.get(context, {}).get("branch create", 0)
    pattern = re.compile(r"git-spice --no-prompt branch create(?P<arguments>[^`\n]*)")

    def replacement(match: re.Match[str]) -> str:
        executable, comment = split_command_comment(match.group("arguments"))
        if not executable:
            executable = '<name> -m "<message>"'
        elif not re.search(r"(?:^|\s)(?:-m|--message)(?:\s|=)", executable) and "--no-commit" not in executable:
            executable += ' -m "<message>"'
        return "git-spice --no-prompt branch create " + executable + comment

    return checked_sub(pattern, replacement, text, expected, context, "branch create mutations")


def make_init_mutations_explicit(text: str, context: str) -> str:
    mutations = EXPECTED_MUTATION_ANCHORS.get(context, {})
    expected = mutations.get("init", 0) + mutations.get("reset", 0)
    pattern = re.compile(r"git-spice --no-prompt repo init(?P<arguments>[^`\n]*)")

    def replacement(match: re.Match[str]) -> str:
        executable, comment = split_command_comment(match.group("arguments"))
        parts = executable.split()
        trunk = next((part for part in parts if part.startswith("--trunk=")), "--trunk=<name>")
        remote = next((part for part in parts if part.startswith("--remote=")), "--remote=<name>")
        remainder = " ".join(part for part in parts if not part.startswith(("--trunk=", "--remote=")))
        executable = " ".join(part for part in (trunk, remote, remainder) if part)
        return "git-spice --no-prompt repo init " + executable + comment

    return checked_sub(pattern, replacement, text, expected, context, "repo init mutations")


def make_submit_drafts_explicit(text: str, context: str) -> str:
    expected = EXPECTED_MUTATION_ANCHORS.get(context, {}).get("submit", 0)
    pattern = re.compile(r"git-spice --no-prompt (?P<scope>branch|upstack|downstack|stack|<scope>) submit(?P<arguments>[^`\n]*)")

    def replacement(match: re.Match[str]) -> str:
        executable, comment = split_command_comment(match.group("arguments"))
        has_draft = re.search(r"(?:^|\s)(?:--draft|--no-draft|<draft-flag>)(?:\s|$)", executable)
        if not has_draft and not re.search(r"(?:^|\s)--update-only(?:\s|$)", executable):
            parts = executable.split()
            extra_flags = parts.index("<extra-flags>") if "<extra-flags>" in parts else len(parts)
            parts.insert(extra_flags, "<draft-flag>")
            executable = " ".join(parts)
        suffix = (" " + executable) if executable else ""
        return f"git-spice --no-prompt {match.group('scope')} submit{suffix}" + comment

    return checked_sub(pattern, replacement, text, expected, context, "submit mutations")


def make_sync_restack_explicit(text: str, context: str) -> str:
    expected = EXPECTED_MUTATION_ANCHORS.get(context, {}).get("sync", 0)
    pattern = re.compile(r"git-spice --no-prompt repo sync(?P<arguments>[^`\n]*)")

    def replacement(match: re.Match[str]) -> str:
        executable, comment = split_command_comment(match.group("arguments"))
        if not re.search(r"(?:^|\s)--restack(?:=\S+)?(?:\s|$)", executable):
            executable += " --restack"
        suffix = " " + executable.strip()
        return "git-spice --no-prompt repo sync" + suffix + comment

    return checked_sub(pattern, replacement, text, expected, context, "repo sync mutations")


def transform_executable_guidance(text: str, context: str) -> str:
    validate_transformation_anchors(text, context)
    text = make_commands_noninteractive(text, context)
    text = make_alias_mutations_explicit(text, context)
    text = make_rebase_continuations_noninteractive(text, context)
    text = make_branch_creations_explicit(text, context)
    text = make_init_mutations_explicit(text, context)
    text = make_submit_drafts_explicit(text, context)
    return make_sync_restack_explicit(text, context)


def transform_prompt(source_relative: str, text: str) -> str:
    if source_relative not in PROMPT_SAFETY_APPENDICES:
        raise RuntimeError(f"Unsupported source prompt: {source_relative}")
    fields, body = parse_prompt_frontmatter(text, source_relative)
    validate_transformation_anchors(body, source_relative)
    anchor = PROMPT_ANCHORS[source_relative]
    require_replace(body, anchor, anchor, source_relative)
    body = transform_prompt_references(body, source_relative)
    if source_relative == "commands/init.md":
        body = require_replace(
            body,
            "3. Run `git-spice repo init`. If `$ARGUMENTS` was provided, treat it as either a trunk branch name or `--trunk=<name> --remote=<name>` flags and pass it through. Otherwise let the interactive prompt run.",
            "3. Resolve `$ARGUMENTS` to explicit `--trunk=<name> --remote=<name>` values. If either value is absent, gather it through an available user-question tool or plain chat; stop if it remains unavailable. Run `git-spice repo init --trunk=<name> --remote=<name>`.",
            source_relative,
        )
    if source_relative == "commands/new.md":
        body = require_replace(
            body,
            "1. Parse `$ARGUMENTS` as the branch name. If empty, ask the user for one (or note that git-spice will auto-generate from the commit message if `--no-commit` isn't used).",
            "1. Parse `$ARGUMENTS` as the branch name. If empty, gather an explicit name through an available user-question tool or plain chat; stop if it remains unavailable.",
            source_relative,
        )
    body = transform_executable_guidance(body, source_relative)
    body = body.rstrip() + "\n\n" + PROMPT_SAFETY_APPENDICES[source_relative].rstrip()
    return render_prompt(fields, body)


def replace_section(text: str, start: str, end: str, replacement: str, context: str) -> str:
    start_count = text.count(start)
    end_count = text.count(end)
    if start_count != 1 or end_count != 1:
        raise RuntimeError(f"Expected exactly one semantic section while patching {context}; start={start_count}, end={end_count}")
    first = text.index(start)
    last = text.index(end, first)
    return text[:first] + replacement.rstrip() + "\n\n" + text[last:]


def transform_git_spice_skill(text: str) -> str:
    context = "skills/git-spice/SKILL.md"
    normalized = validate_skill_frontmatter(text, "git-spice", context)
    frontmatter, body = split_frontmatter(normalized, context)
    validate_transformation_anchors(body, context)
    body = replace_section(body, "## Dispatching the subagents", "## Configuration", "## Dispatching optional Pi subagents\n\n" + DISPATCH_CONTRACT, context)
    body = require_replace(body, "git-spice is a CLI for managing **stacks of dependent Git branches**.", "The git-spice CLI manages **stacks of dependent Git branches**.", context)
    body = require_replace(body, "git-spice operations are *local-first*.", "The git-spice CLI's operations are *local-first*.", context)
    body = require_replace(body, "git-spice rebases run `git rebase` under the hood.", "The git-spice CLI runs `git rebase` under the hood.", context)
    body = body.replace("git-spice won't auto-advance", "`git-spice` won't auto-advance")
    body = transform_prompt_references(body, context)
    body = transform_executable_guidance(body, context)
    body = body.rstrip() + "\n\n" + INIT_SAFETY_CONTRACT.rstrip() + "\n\n" + SUBMIT_DRAFT_CONTRACT.rstrip()
    return "---\n" + frontmatter + "\n---\n\n" + body.rstrip() + "\n"


def transform_stacking_workflow(text: str) -> str:
    context = "skills/stacking-workflow/SKILL.md"
    normalized = validate_skill_frontmatter(text, "stacking-workflow", context)
    frontmatter, body = split_frontmatter(normalized, context)
    validate_transformation_anchors(body, context)
    body = replace_section(body, "## Driving with subagents", "## Don't", "## Driving with optional Pi subagents\n\n" + DISPATCH_CONTRACT, context)
    body = transform_prompt_references(body, context)
    body = transform_executable_guidance(body, context)
    body = body.rstrip() + "\n\n" + SUBMIT_DRAFT_CONTRACT.rstrip()
    return "---\n" + frontmatter + "\n---\n\n" + body.rstrip() + "\n"


def transform_agent(source_relative: str, text: str) -> str:
    name, expected_tools, anchor = AGENT_CONFIG[source_relative]
    description, tools, body = parse_agent_frontmatter(text, expected_tools, source_relative)
    validate_transformation_anchors(body, source_relative)
    require_replace(body, anchor, anchor, source_relative)
    if name == "stacker":
        body = require_replace(
            body,
            "`git-spice branch create <prefix><slug>` (uses staged changes as the commit). The commit message defaults to the staged changes; if the task description maps to a clean conventional-commit subject, prefer `git-spice branch create <name> -m \"<subject>\"`.",
            "`git-spice branch create <prefix><slug> -m \"<subject>\"`. Gather the subject explicitly; use `git-spice branch create <name> -m \"<subject>\"` rather than relying on defaults or opening an editor.",
            source_relative,
        )
    if name == "stack-doctor":
        body = require_replace(
            body,
            "| Branches exist in git but not in `log long --all` | untracked | `git-spice branch track` per branch, or `git-spice downstack track` from the top |",
            "| Branches exist in git but not in `log long --all` | untracked | Gather or derive each exact untracked branch name and the exact top branch name first. If branch names are ambiguous or missing configuration prevents deriving them, report it and stop rather than enabling prompts. Run `git-spice branch track <branch>` for each branch, or `git-spice downstack track <top-branch>` for whole-stack tracking. |",
            source_relative,
        )
    body = transform_executable_guidance(body, source_relative)
    if name == "stack-doctor":
        body = body.rstrip() + "\n\n" + INIT_SAFETY_CONTRACT.rstrip() + "\n\n" + SUBMIT_DRAFT_CONTRACT.rstrip()
    tool_names = ", ".join(TOOL_MAP[tool] for tool in tools)
    return "\n".join((
        "---",
        f"name: {name}",
        "package: git-spice",
        f"description: {description}",
        f"tools: {tool_names}",
        "inheritProjectContext: true",
        "defaultContext: fresh",
        "---",
        "",
        body.rstrip(),
        "",
    ))


def build_generated_tree(source: Path, temporary_root: Path) -> Path:
    generated = temporary_root / "generated"
    for source_relative, target_relative in RUNTIME_MANIFEST:
        text = (source / source_relative).read_text(encoding="utf8")
        if source_relative.startswith("commands/"):
            output = transform_prompt(source_relative, text)
        elif source_relative == "skills/git-spice/SKILL.md":
            output = transform_git_spice_skill(text)
        elif source_relative == "skills/stacking-workflow/SKILL.md":
            output = transform_stacking_workflow(text)
        else:
            output = transform_agent(source_relative, text)
        target = generated / target_relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(output, encoding="utf8")
    return generated


@dataclass
class MarkdownRegion:
    kind: str
    start: int
    end: int
    line: int
    content_start: int
    content_end: int
    fence_character: str | None = None
    opening_fence_length: int | None = None
    info_string: str | None = None
    malformed_reason: str | None = None


@dataclass
class GitSpiceOccurrence:
    start: int
    end: int
    line: int
    column: int
    region: MarkdownRegion
    physical_line: str
    classification: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class ProseReferenceManifestEntry:
    exact_physical_line: str
    expected_count: int


PROSE_REFERENCE_REASON = "exact physical-line prose reference manifest match"
PROSE_REFERENCE_MANIFEST = {
    "prompts/git-spice-continue.md": (
        ProseReferenceManifestEntry("description: Resume a git-spice operation after resolving rebase conflicts (or abort with --abort)", 1),
        ProseReferenceManifestEntry("Resume — or abort — a git-spice operation that was paused on a rebase conflict.", 1),
        ProseReferenceManifestEntry("Why `git-spice --no-prompt rebase continue --no-edit` and not `git rebase --continue`? git-spice's wrapper resumes the *outer* operation (e.g., a stack restack across N branches). Plain `git rebase --continue` only finishes the current branch's rebase and leaves git-spice's queue stalled.", 2),
    ),
    "prompts/git-spice-init.md": (
        ProseReferenceManifestEntry("description: Initialize git-spice in the current repo (sets trunk + remote, checks auth)", 1),
        ProseReferenceManifestEntry("Initialize git-spice for this repository.", 1),
        ProseReferenceManifestEntry("2. Check whether git-spice is already initialized: `git-spice --no-prompt log long 2>&1`. If it succeeds and shows a trunk, tell the user it's already initialized and offer to re-init with `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset` only if they ask.", 1),
        ProseReferenceManifestEntry("Do not run argumentless initialization in Pi. Gather an explicit trunk and remote through an available user-question tool, or through plain chat when that tool is unavailable; if either value is unavailable, stop. Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. For `--reset`, disclose that it forgets all git-spice tracking relationships while leaving Git branches, and obtain a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.", 1),
    ),
    "prompts/git-spice-new.md": (),
    "prompts/git-spice-restack.md": (),
    "prompts/git-spice-stack.md": (
        ProseReferenceManifestEntry("- If a restack appears pending (git-spice may flag this): note that and suggest `/git-spice-restack`.", 1),
    ),
    "prompts/git-spice-submit.md": (
        ProseReferenceManifestEntry("5. After submit, summarize: which CRs were created vs updated, and the URLs (git-spice prints them).", 1),
    ),
    "prompts/git-spice-sync.md": (),
    "skills/git-spice/SKILL.md": (
        ProseReferenceManifestEntry("  Reference for the git-spice CLI — stacked-branch workflows, command map, and recovery from interrupted rebases. This skill should be used whenever the user mentions git-spice, `gs`, stacked PRs, stacked diffs, branch stacks, dependent branches, PRs that depend on each other, or says things like \"stack this\", \"check the stack\", \"submit the stack\", \"submit my stacked PRs\", \"restack\", \"rebase failed\", \"sync after merge\", \"what's on top of <branch>\", \"branch above/below\". Also load when a multi-step plan would naturally produce a chain of dependent branches and you need to drive that with the CLI, or when an interrupted rebase needs recovery.", 2),
        ProseReferenceManifestEntry("The git-spice CLI manages **stacks of dependent Git branches**. Each branch (except the trunk) has a recorded *base* — the branch it was created from. git-spice tracks those relationships, restacks (rebases) dependents automatically when a base changes, and submits the whole chain as separate-but-linked Change Requests (CRs — PRs on GitHub, MRs on GitLab).", 2),
        ProseReferenceManifestEntry("The git-spice CLI's operations are *local-first*. Auth is only needed for `submit`/`sync` (network operations).", 1),
        ProseReferenceManifestEntry("| Initialize git-spice in this repo | `git-spice --no-prompt repo init --trunk=<name> --remote=<name>` (`git-spice --no-prompt r i --trunk=<name> --remote=<name>`) |", 1),
        ProseReferenceManifestEntry("> Prefer `git-spice --no-prompt commit ...` over raw `git commit` while inside a stack. The git-spice variants restack everything above the current branch automatically; `git commit` leaves upstack branches misaligned and you'll have to run `git-spice --no-prompt upstack restack` yourself.", 1),
        ProseReferenceManifestEntry("The git-spice CLI runs `git rebase` under the hood. Conflicts pause the operation. **Resolve with the git-spice variants, not raw git:**", 2),
        ProseReferenceManifestEntry("2. Run `git-spice --no-prompt rebase continue --no-edit`. git-spice resumes its multi-branch operation (e.g., a stack restack continues onto the next branch).", 1),
        ProseReferenceManifestEntry("- **Don't `git push --force`** on a tracked branch. Use `git-spice --no-prompt <scope> submit <draft-flag>` — git-spice uses `--force-with-lease` semantics and updates only the branches that need it.", 1),
        ProseReferenceManifestEntry("- **Don't assume `gs`** is git-spice in commands you write. Always `git-spice`.", 1),
        ProseReferenceManifestEntry("For every initialization, reconfiguration, or recovery path, gather both trunk and remote from explicit arguments, a Pi user-question tool, or plain chat. Always run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. A reset forgets all git-spice tracking relationships while leaving Git branches; disclose that impact and require a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.", 1),
    ),
    "skills/stacking-workflow/SKILL.md": (),
    "agents/stack-doctor.md": (
        ProseReferenceManifestEntry("description: Use this agent to diagnose and repair a wedged git-spice stack — interrupted rebases, branches diverged from their bases, untracked branches that should be tracked, wrong trunk recorded, or generally confused state. Dispatch when manual fixes aren't working or when the failure mode isn't obvious. Read-mostly during diagnosis; mutations only after explaining the plan in the report.", 1),
        ProseReferenceManifestEntry("You diagnose and repair broken git-spice stacks. Default to *read-only* during diagnosis. Mutations are deliberate, narrowly scoped, and explained in your final report. You have a fresh context — everything you need is in the dispatch prompt and what you discover by inspecting the repo.", 1),
        ProseReferenceManifestEntry("2. **Never `git rebase --continue` directly during a git-spice operation.** Use `git-spice --no-prompt rebase continue --no-edit`. Plain git only finishes the inner rebase and leaves git-spice's outer queue stalled.", 2),
        ProseReferenceManifestEntry("For every initialization, reconfiguration, or recovery path, gather both trunk and remote from explicit arguments, a Pi user-question tool, or plain chat. Always run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. A reset forgets all git-spice tracking relationships while leaving Git branches; disclose that impact and require a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.", 1),
    ),
    "agents/stacker.md": (
        ProseReferenceManifestEntry("description: Use this agent to build a stack of dependent git-spice branches from an ordered list of changes. Dispatch when you have a multi-step plan whose pieces must ship in order and you want the execution loop (implement → stage → branch create → repeat) handled in a single pass. Receives the task list and the starting branch in its prompt; reports back per-branch results.", 1),
        ProseReferenceManifestEntry("You build a stack of git-spice branches from an ordered list of changes. You receive the list, the starting branch, and any context the dispatcher chose to include. You have a fresh context — everything you need is in the dispatch prompt.", 1),
        ProseReferenceManifestEntry("You run unattended — an interactive prompt will hang you. Always pass explicit arguments (branch names, commit messages) and add the global `--no-prompt` flag to git-spice commands so missing information fails fast instead of prompting. A `--no-prompt` failure is a `BLOCKED`/`NEEDS_CONTEXT` signal, not something to work around.", 1),
    ),
}


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _append_prose_region(regions: list[MarkdownRegion], text: str, start: int, end: int) -> None:
    if start < end:
        regions.append(MarkdownRegion("prose", start, end, _line_number(text, start), start, end))


def _escaped_delimiter(line: str, index: int) -> bool:
    backslashes = 0
    index -= 1
    while index >= 0 and line[index] == "\\":
        backslashes += 1
        index -= 1
    return backslashes % 2 == 1


def _scan_inline_regions(text: str, line_start: int, line_end: int, regions: list[MarkdownRegion]) -> None:
    physical_end = line_end
    while physical_end > line_start and text[physical_end - 1] in "\r\n":
        physical_end -= 1
    line = text[line_start:physical_end]
    cursor = 0
    search = 0
    while search < len(line):
        opener = re.search(r"`+", line[search:])
        if not opener:
            break
        opening_start = search + opener.start()
        opening_end = search + opener.end()
        if _escaped_delimiter(line, opening_start):
            search = opening_end
            continue
        delimiter_length = opening_end - opening_start
        closing_start = None
        closing_end = None
        for candidate in re.finditer(r"`+", line[opening_end:]):
            candidate_start = opening_end + candidate.start()
            candidate_end = opening_end + candidate.end()
            if candidate_end - candidate_start == delimiter_length and not _escaped_delimiter(line, candidate_start):
                closing_start = candidate_start
                closing_end = candidate_end
                break
        _append_prose_region(regions, text, line_start + cursor, line_start + opening_start)
        if closing_start is None or closing_end is None:
            malformed = "unterminated inline code span" if "git-spice" in line[opening_start:] else None
            regions.append(MarkdownRegion(
                "inline_code",
                line_start + opening_start,
                line_end,
                _line_number(text, line_start + opening_start),
                line_start + opening_end,
                physical_end,
                malformed_reason=malformed,
            ))
            return
        regions.append(MarkdownRegion(
            "inline_code",
            line_start + opening_start,
            line_start + closing_end,
            _line_number(text, line_start + opening_start),
            line_start + opening_end,
            line_start + closing_start,
        ))
        cursor = closing_end
        search = closing_end
    _append_prose_region(regions, text, line_start + cursor, line_end)


def scan_markdown_regions(text: str) -> list[MarkdownRegion]:
    """Partition Markdown with an offset-preserving deterministic state machine."""
    regions = []
    lines = text.splitlines(keepends=True)
    if not lines and text:
        lines = [text]
    offset = 0
    fence_start = None
    fence_line = None
    fence_character = None
    fence_length = None
    fence_info = None
    fence_content_start = None
    fence_problem = None
    opener_pattern = re.compile(r" {0,3}(`{3,}|~{3,})([^\n]*)")

    for raw_line in lines:
        line_start = offset
        line_end = offset + len(raw_line)
        physical_line = raw_line.rstrip("\r\n")
        if fence_start is None:
            opener = opener_pattern.fullmatch(physical_line)
            if opener:
                fence_start = line_start
                fence_line = _line_number(text, line_start)
                fence_character = opener.group(1)[0]
                fence_length = len(opener.group(1))
                fence_info = opener.group(2).strip()
                fence_content_start = line_end
                fence_problem = None
            else:
                _scan_inline_regions(text, line_start, line_end, regions)
        else:
            closer = re.fullmatch(
                rf" {{0,3}}{re.escape(fence_character)}{{{fence_length},}}[ \t]*",
                physical_line,
            )
            if closer:
                regions.append(MarkdownRegion(
                    "fenced_code",
                    fence_start,
                    line_end,
                    fence_line,
                    fence_content_start,
                    line_start,
                    fence_character=fence_character,
                    opening_fence_length=fence_length,
                    info_string=fence_info,
                    malformed_reason=fence_problem,
                ))
                fence_start = None
            else:
                apparent_closer = re.fullmatch(r" {0,3}(`{3,}|~{3,})[ \t]*", physical_line)
                if apparent_closer and fence_problem is None:
                    run = apparent_closer.group(1)
                    if run[0] != fence_character:
                        fence_problem = "mismatched closing fence character"
                    elif len(run) < fence_length:
                        fence_problem = "closing fence is shorter than its opener"
        offset = line_end

    if fence_start is not None:
        regions.append(MarkdownRegion(
            "fenced_code",
            fence_start,
            len(text),
            fence_line,
            fence_content_start,
            len(text),
            fence_character=fence_character,
            opening_fence_length=fence_length,
            info_string=fence_info,
            malformed_reason=fence_problem or "unterminated fenced code block",
        ))
    regions.sort(key=lambda region: region.start)
    return regions


def inventory_git_spice_occurrences(text: str, regions: list[MarkdownRegion]) -> list[GitSpiceOccurrence]:
    occurrences = []
    for match in re.finditer(re.escape("git-spice"), text):
        containing = [region for region in regions if region.start <= match.start() and match.end() <= region.end]
        if len(containing) != 1:
            raise RuntimeError("git-spice occurrence inventory did not map to exactly one Markdown region")
        line_start = text.rfind("\n", 0, match.start()) + 1
        line_end = text.find("\n", match.end())
        if line_end == -1:
            line_end = len(text)
        physical_line = text[line_start:line_end].removesuffix("\r")
        occurrences.append(GitSpiceOccurrence(
            match.start(),
            match.end(),
            _line_number(text, match.start()),
            match.start() - line_start + 1,
            containing[0],
            physical_line,
        ))
    return occurrences


def _structured_identifier_reference(text: str, occurrence: GitSpiceOccurrence) -> bool:
    identifier_characters = "._:/-"
    before = text[occurrence.start - 1] if occurrence.start else ""
    after = text[occurrence.end] if occurrence.end < len(text) else ""
    return bool(
        (before and (before.isalnum() or before in identifier_characters))
        or (after and (after.isalnum() or after in identifier_characters))
    )


def _exact_metadata_identifier_reference(occurrence: GitSpiceOccurrence) -> bool:
    return occurrence.physical_line in {"name: git-spice", "package: git-spice"}


def _unquoted_comment_index(line: str) -> int | None:
    quote = None
    index = 0
    while index < len(line):
        character = line[index]
        if quote == "'":
            if character == "'":
                quote = None
            index += 1
            continue
        if quote == '"':
            if character == "\\" and index + 1 < len(line):
                index += 2
                continue
            if character == '"':
                quote = None
            index += 1
            continue
        if character == "\\" and index + 1 < len(line):
            index += 2
            continue
        if character in {"'", '"'}:
            quote = character
            index += 1
            continue
        if character == "#" and (index == 0 or line[index - 1].isspace() or line[index - 1] in ";&|()"):
            return index
        index += 1
    return None


def _markdown_content_start(line: str) -> int:
    index = 0
    for _ in range(8):
        match = re.match(r" {0,3}>[ \t]?", line[index:])
        if not match:
            break
        index += match.end()
    list_prefix = re.match(r" {0,3}(?:[-+*]|\d+[.)])[ \t]+", line[index:])
    if list_prefix:
        index += list_prefix.end()
        task_prefix = re.match(r"\[[ xX]\][ \t]+", line[index:])
        if task_prefix:
            index += task_prefix.end()
    else:
        leading = re.match(r" {0,3}", line[index:])
        index += leading.end()
    return index


def _shell_position_reason(line: str, occurrence_column: int) -> str | None:
    content_start = _markdown_content_start(line)
    if occurrence_column < content_start:
        return None
    prefix = line[content_start:occurrence_column]
    quote = None
    escaped = False
    boundary = 0
    index = 0
    while index < len(prefix):
        character = prefix[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if character == "\\" and quote != "'":
            escaped = True
            index += 1
            continue
        if quote:
            if character == quote:
                quote = None
            index += 1
            continue
        if character in {"'", '"'}:
            quote = character
            index += 1
            continue
        if character in ";&|":
            boundary = index + 1
            while boundary < len(prefix) and prefix[boundary] in ";&|":
                boundary += 1
            index = boundary
            continue
        if character == "(":
            before_parenthesis = prefix[:index].rstrip()
            if not before_parenthesis or before_parenthesis[-1] in ";&|)(":
                boundary = index + 1
            index += 1
            continue
        index += 1
    if quote:
        return None
    segment = prefix[boundary:].strip()
    if not segment:
        return "shell command position after a Markdown prefix or control boundary"
    try:
        segment_tokens = shlex.split(segment, posix=True)
    except ValueError:
        return None
    if segment_tokens and all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", token) for token in segment_tokens):
        return "shell command position after environment assignments"
    return None


def _has_argument_text(line: str, occurrence: GitSpiceOccurrence) -> bool:
    suffix = line[occurrence.column - 1 + len("git-spice"):]
    comment = _unquoted_comment_index(suffix)
    if comment is not None:
        suffix = suffix[:comment]
    return bool(suffix.strip())


def _code_region_has_argument_text(text: str, occurrence: GitSpiceOccurrence) -> bool:
    if occurrence.region.kind == "inline_code":
        return bool(text[occurrence.end:occurrence.region.content_end].strip())
    return _has_argument_text(occurrence.physical_line, occurrence)


def _manifest_entries(path: Path) -> tuple[ProseReferenceManifestEntry, ...]:
    expected_targets = {target for _, target in RUNTIME_MANIFEST}
    actual_targets = set(PROSE_REFERENCE_MANIFEST)
    unknown_targets = sorted(actual_targets - expected_targets)
    missing_targets = sorted(expected_targets - actual_targets)
    if unknown_targets or missing_targets:
        raise ValueError(
            "prose reference manifest target mismatch; "
            f"missing={missing_targets!r}, unknown={unknown_targets!r}"
        )
    for target, entries in PROSE_REFERENCE_MANIFEST.items():
        seen_lines = set()
        for entry in entries:
            if not isinstance(entry, ProseReferenceManifestEntry):
                raise ValueError(f"invalid prose reference manifest entry for {target}")
            if entry.exact_physical_line in seen_lines:
                raise ValueError(
                    f"duplicate prose reference manifest entry for {target}: "
                    f"{entry.exact_physical_line!r}"
                )
            seen_lines.add(entry.exact_physical_line)
            if type(entry.expected_count) is not int or entry.expected_count <= 0:
                raise ValueError(
                    f"invalid prose reference manifest cardinality for {target}: "
                    f"{entry.expected_count!r}"
                )
            if "git-spice" not in entry.exact_physical_line:
                raise ValueError(
                    f"prose reference manifest entry for {target} does not contain git-spice: "
                    f"{entry.exact_physical_line!r}"
                )
    return PROSE_REFERENCE_MANIFEST.get(path.as_posix(), ())


def _classify(occurrence: GitSpiceOccurrence, classification: str, reason: str) -> GitSpiceOccurrence:
    if occurrence.classification is not None or occurrence.reason is not None:
        raise RuntimeError("git-spice occurrence was classified more than once")
    occurrence.classification = classification
    occurrence.reason = reason
    return occurrence


def classify_occurrence(
    text: str,
    occurrence: GitSpiceOccurrence,
    path: Path | None = None,
    manifest_usage: dict[str, int] | None = None,
) -> GitSpiceOccurrence:
    if occurrence.region.malformed_reason:
        raise ValueError(occurrence.region.malformed_reason)

    line_offset = occurrence.column - 1
    region = occurrence.region
    if region.kind in {"inline_code", "fenced_code"}:
        if _structured_identifier_reference(text, occurrence):
            return _classify(occurrence, "reference", "identifier-adjacent git-spice reference")
        if not (region.content_start <= occurrence.start and occurrence.end <= region.content_end):
            raise ValueError("git-spice occurrence appears in a Markdown code delimiter or fence info string")
        comment = _unquoted_comment_index(occurrence.physical_line)
        if region.kind == "fenced_code" and comment is not None and comment <= line_offset:
            return _classify(occurrence, "reference", "shell comment reference")
        if _code_region_has_argument_text(text, occurrence):
            return _classify(occurrence, "executable", "argument-bearing occurrence in a Markdown code region")
        if region.kind == "inline_code":
            region_text = text[region.content_start:region.content_end].strip()
            if region_text == "git-spice":
                return _classify(occurrence, "reference", "exact standalone inline code token")
        uncommented_line = occurrence.physical_line
        line_comment = _unquoted_comment_index(uncommented_line)
        if line_comment is not None:
            uncommented_line = uncommented_line[:line_comment]
        if uncommented_line.strip() == "git-spice":
            return _classify(occurrence, "reference", "exact standalone fenced code token")
        raise ValueError("unlisted non-command git-spice occurrence in a Markdown code region")

    shell_reason = _shell_position_reason(occurrence.physical_line, line_offset)
    if shell_reason:
        return _classify(occurrence, "executable", shell_reason)
    comment = _unquoted_comment_index(occurrence.physical_line)
    if comment is not None and comment <= line_offset:
        return _classify(occurrence, "reference", "shell comment reference")
    if _structured_identifier_reference(text, occurrence):
        return _classify(occurrence, "reference", "identifier-adjacent git-spice reference")
    if _exact_metadata_identifier_reference(occurrence):
        return _classify(occurrence, "reference", "exact package or skill identifier")
    if path is None or manifest_usage is None:
        raise ValueError("unlisted prose reference in prose manifest outside shell command position")
    entries = {entry.exact_physical_line: entry for entry in _manifest_entries(path)}
    entry = entries.get(occurrence.physical_line)
    if entry is None:
        raise ValueError("unlisted prose reference in prose manifest outside shell command position")
    observed = manifest_usage.get(entry.exact_physical_line, 0) + 1
    manifest_usage[entry.exact_physical_line] = observed
    if observed > entry.expected_count:
        raise ValueError(
            "prose reference manifest cardinality exceeded; "
            f"expected={entry.expected_count}, observed={observed}"
        )
    return _classify(occurrence, "reference", PROSE_REFERENCE_REASON)


def classify_git_spice_occurrences(text: str, occurrences: list[GitSpiceOccurrence]) -> list[GitSpiceOccurrence]:
    for occurrence in occurrences:
        classify_occurrence(text, occurrence)
    return occurrences


def strip_shell_comments(snippet: str) -> str:
    result = []
    quote = None
    index = 0
    while index < len(snippet):
        character = snippet[index]
        if quote == "'":
            result.append(character)
            if character == "'":
                quote = None
            index += 1
            continue
        if quote == '"':
            result.append(character)
            if character == "\\" and index + 1 < len(snippet):
                result.append(snippet[index + 1])
                index += 2
                continue
            if character == '"':
                quote = None
            index += 1
            continue
        if character == "\\" and index + 1 < len(snippet):
            result.extend((character, snippet[index + 1]))
            index += 2
            continue
        if character in {"'", '"'}:
            quote = character
            result.append(character)
            index += 1
            continue
        if character == "#" and (not result or result[-1].isspace() or result[-1] in ";&|()"):
            newline = snippet.find("\n", index)
            if newline == -1:
                break
            result.append("\n")
            index = newline + 1
            continue
        result.append(character)
        index += 1
    return "".join(result)


def tokenize_executable_snippet(snippet: str) -> list[str]:
    uncommented = strip_shell_comments(snippet)
    normalized = re.sub(r"\\\r?\n", " ", uncommented).replace("\r\n", "\n").replace("\n", " ; ")
    lexer = shlex.shlex(normalized, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def is_shell_control_token(token: str) -> bool:
    return bool(token) and all(character in ";&|()" for character in token)


def _physical_line_continues(line: str) -> bool:
    comment = _unquoted_comment_index(line)
    if comment is not None:
        line = line[:comment]
    trailing_backslashes = len(line) - len(line.rstrip("\\"))
    return trailing_backslashes % 2 == 1


def _continued_prose_source_end(text: str, occurrence: GitSpiceOccurrence) -> int:
    line_start = occurrence.start - (occurrence.column - 1)
    while True:
        line_end = text.find("\n", line_start)
        if line_end == -1:
            return len(text)
        physical_line = text[line_start:line_end].removesuffix("\r")
        if not _physical_line_continues(physical_line):
            return line_end
        line_start = line_end + 1


def _occurrence_source_end(text: str, occurrence: GitSpiceOccurrence) -> int:
    if occurrence.region.kind in {"inline_code", "fenced_code"}:
        return occurrence.region.content_end
    return _continued_prose_source_end(text, occurrence)


def extract_shell_invocations(text: str, executable_occurrences: list[GitSpiceOccurrence]) -> list[list[str]]:
    invocations = []
    for occurrence in executable_occurrences:
        physical = occurrence.physical_line.strip()
        if physical.startswith("<") and physical.endswith(">"):
            snippet = occurrence.physical_line[occurrence.column - 1:].rstrip()[:-1]
        else:
            snippet = text[occurrence.start:_occurrence_source_end(text, occurrence)]
        tokens = tokenize_executable_snippet(snippet)
        if not tokens or tokens[0] != "git-spice":
            raise ValueError("argument-bearing git-spice occurrence could not be shell-tokenized as an invocation")
        end = 1
        while end < len(tokens) and not is_shell_control_token(tokens[end]):
            end += 1
        invocations.append(tokens[:end])
    return invocations


def executable_git_spice_invocations(text: str) -> list[list[str]]:
    regions = scan_markdown_regions(text)
    occurrences = inventory_git_spice_occurrences(text, regions)
    classify_git_spice_occurrences(text, occurrences)
    executable = [occurrence for occurrence in occurrences if occurrence.classification == "executable"]
    return extract_shell_invocations(text, executable)


def executable_git_spice_commands(text: str) -> list[str]:
    return [" ".join(invocation) for invocation in executable_git_spice_invocations(text)]


def parse_git_spice_arguments(arguments: list[str]) -> tuple[list[str], set[str]]:
    command_arguments = []
    global_flags = set()
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in GLOBAL_FLAG_OPTIONS or re.fullmatch(r"--(?:verbose|prompt)=\S+", argument):
            global_flags.add(argument)
            index += 1
            continue
        if argument in GLOBAL_VALUE_OPTIONS:
            if index + 1 >= len(arguments):
                raise ValueError(f"global option {argument!r} requires a value")
            index += 2
            continue
        if re.fullmatch(r"--dir=\S+", argument) or (argument.startswith("-C") and argument != "-C"):
            index += 1
            continue
        command_arguments.append(argument)
        index += 1
    return command_arguments, global_flags


def classify_git_spice_command(arguments: list[str]) -> tuple[str, tuple[str, ...]]:
    for classification, signatures in (("read-only", READ_ONLY_COMMAND_SIGNATURES), ("mutation", MUTATING_COMMAND_SIGNATURES)):
        for signature in signatures:
            if tuple(arguments[:len(signature)]) == signature:
                return classification, signature
    raise ValueError("unclassified git-spice subcommand")


def has_message_argument(arguments: list[str]) -> bool:
    for index, argument in enumerate(arguments):
        if argument == "-m" and index + 1 < len(arguments) and arguments[index + 1]:
            return True
        if argument == "--message" and index + 1 < len(arguments) and arguments[index + 1]:
            return True
        if argument.startswith("--message=") and argument != "--message=":
            return True
    return "--no-commit" in arguments


def validate_git_spice_invocation(raw_arguments: list[str], path: Path | None = None) -> None:
    arguments, global_flags = parse_git_spice_arguments(raw_arguments)
    _, signature = classify_git_spice_command(arguments)
    if "--no-prompt" not in global_flags:
        raise ValueError("mutation and read-only guidance must be explicitly non-interactive")
    if signature in {("repo", "init"), ("r", "i")}:
        if not any(re.fullmatch(r"--trunk=<[^>]+>", argument) for argument in arguments):
            raise ValueError("repo init requires an explicit trunk")
        if not any(re.fullmatch(r"--remote=<[^>]+>", argument) for argument in arguments):
            raise ValueError("repo init requires an explicit remote")
    if signature in {("branch", "create"), ("bc",)} and not has_message_argument(arguments):
        raise ValueError("branch creation requires a populated or clean-tree mode")
    if signature in {("rebase", "continue"), ("rbc",)} and "--no-edit" not in arguments:
        raise ValueError("rebase continuation requires --no-edit")
    if signature in {
        ("branch", "submit"),
        ("upstack", "submit"),
        ("downstack", "submit"),
        ("stack", "submit"),
        ("<scope>", "submit"),
        ("bs",),
        ("dss",),
        ("uss",),
        ("ss",),
    } and "--update-only" not in arguments:
        if not any(argument in {"--draft", "--no-draft", "<draft-flag>"} for argument in arguments):
            raise ValueError("create-capable submit requires an explicit draft state")
    if path is not None and path.as_posix() == "agents/stack-doctor.md":
        required_tracking_targets = {
            ("branch", "track"): "<branch>",
            ("downstack", "track"): "<top-branch>",
        }
        if signature in required_tracking_targets and required_tracking_targets[signature] not in arguments[len(signature):]:
            raise ValueError("stack-doctor tracking guidance requires an explicit target")
    if signature in {("repo", "sync"), ("rs",)}:
        if not any(argument == "--restack" or re.fullmatch(r"--restack=\S+", argument) for argument in arguments):
            raise ValueError("repo sync requires an explicit non-empty restack mode")


def _trimmed_excerpt(text: str) -> str:
    excerpt = text.strip()
    if len(excerpt) > 160:
        excerpt = excerpt[:157] + "..."
    return excerpt


def _occurrence_diagnostic(path: Path, occurrence: GitSpiceOccurrence, detail: str) -> str:
    return (
        f"Unsafe generated executable git-spice command in {path.as_posix()} "
        f"at line {occurrence.line}, column {occurrence.column}: {detail}; "
        f"excerpt={_trimmed_excerpt(occurrence.physical_line)!r}"
    )


def _inventory_diagnostic(
    path: Path,
    text: str,
    detail: str,
    occurrence: GitSpiceOccurrence | None = None,
) -> str:
    if occurrence is not None:
        return (
            f"{detail} in {path.as_posix()} at line {occurrence.line}, column {occurrence.column}; "
            f"excerpt={_trimmed_excerpt(occurrence.physical_line)!r}"
        )
    offset = text.find("git-spice")
    if offset != -1:
        line_start = text.rfind("\n", 0, offset) + 1
        line_end = text.find("\n", offset)
        if line_end == -1:
            line_end = len(text)
        return (
            f"{detail} in {path.as_posix()} at line {_line_number(text, offset)}, "
            f"column {offset - line_start + 1}; excerpt={_trimmed_excerpt(text[line_start:line_end])!r}"
        )
    return f"{detail} in {path.as_posix()}; excerpt={_trimmed_excerpt(text)!r}"


def audit_git_spice_occurrences(path: Path, text: str) -> list[GitSpiceOccurrence]:
    try:
        manifest_entries = _manifest_entries(path)
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError(_inventory_diagnostic(
            path,
            text,
            f"invalid prose reference manifest: {error}",
        )) from error

    regions = scan_markdown_regions(text)
    try:
        occurrences = inventory_git_spice_occurrences(text, regions)
    except RuntimeError as error:
        raise RuntimeError(_inventory_diagnostic(
            path,
            text,
            f"git-spice occurrence inventory did not reconcile: {error}",
        )) from error

    manifest_usage: dict[str, int] = {}
    for occurrence in occurrences:
        try:
            classify_occurrence(text, occurrence, path, manifest_usage)
        except (RuntimeError, ValueError) as error:
            raise RuntimeError(_occurrence_diagnostic(path, occurrence, f"ambiguous occurrence: {error}")) from error

    for entry in manifest_entries:
        observed = manifest_usage.get(entry.exact_physical_line, 0)
        if observed != entry.expected_count:
            raise RuntimeError(_inventory_diagnostic(
                path,
                text,
                "unused or stale prose reference manifest entry; "
                f"expected={entry.expected_count}, observed={observed}; "
                f"expected line={entry.exact_physical_line!r}",
            ))

    reference_occurrences = [item for item in occurrences if item.classification == "reference"]
    executable_occurrences = [item for item in occurrences if item.classification == "executable"]
    if len(occurrences) != len(reference_occurrences) + len(executable_occurrences):
        unaccounted = next(
            (item for item in occurrences if item.classification not in {"reference", "executable"}),
            occurrences[0] if occurrences else None,
        )
        raise RuntimeError(_inventory_diagnostic(
            path,
            text,
            "git-spice occurrence inventory did not reconcile",
            unaccounted,
        ))
    missing_reason = next((occurrence for occurrence in occurrences if not occurrence.reason), None)
    if missing_reason is not None:
        raise RuntimeError(_inventory_diagnostic(
            path,
            text,
            "git-spice occurrence classification is missing a reason",
            missing_reason,
        ))

    for occurrence in executable_occurrences:
        try:
            invocation = extract_shell_invocations(text, [occurrence])[0]
        except (IndexError, ValueError) as error:
            raise RuntimeError(_occurrence_diagnostic(path, occurrence, f"malformed executable occurrence: {error}")) from error
        command = " ".join(invocation)
        try:
            validate_git_spice_invocation(invocation[1:], path)
        except ValueError as error:
            raise RuntimeError(_occurrence_diagnostic(path, occurrence, f"{command!r}: {error}")) from error
    return occurrences


def validate_generated_commands(path: Path, text: str) -> None:
    audit_git_spice_occurrences(path, text)


def validate_generated_tree(temporary_root: Path) -> None:
    expected = {target for _, target in RUNTIME_MANIFEST}
    actual = {path.relative_to(temporary_root).as_posix() for path in temporary_root.rglob("*") if path.is_file()}
    if actual != expected:
        raise RuntimeError(f"Generated runtime manifest mismatch; expected={sorted(expected)!r}, actual={sorted(actual)!r}")
    roots = tuple(sorted(path.name for path in temporary_root.iterdir() if path.is_dir()))
    if roots != GENERATED_ROOTS:
        raise RuntimeError(f"Generated root set mismatch; expected={GENERATED_ROOTS!r}, actual={roots!r}")
    combined = "\n".join(path.read_text(encoding="utf8") for path in temporary_root.rglob("*.md"))
    for forbidden in FORBIDDEN_GENERATED:
        if forbidden in combined:
            raise RuntimeError(f"Forbidden generated content: {forbidden!r}")
    dispatch = "\n".join((temporary_root / "skills/git-spice/SKILL.md").read_text(encoding="utf8").splitlines() + (temporary_root / "skills/stacking-workflow/SKILL.md").read_text(encoding="utf8").splitlines())
    for required in ("subagent", "git-spice.stacker", "git-spice.stack-doctor", "available", "list agents", "fresh context", "same checkout", "direct workflow"):
        if required not in dispatch:
            raise RuntimeError(f"Generated dispatch contract is missing {required!r}")
    for name in ("stacker", "stack-doctor"):
        agent = (temporary_root / f"agents/{name}.md").read_text(encoding="utf8")
        if f"name: {name}\npackage: git-spice\n" not in agent:
            raise RuntimeError(f"Generated agent identity is invalid: {name}")
    for relative in sorted(expected):
        path = temporary_root / relative
        validate_generated_commands(Path(relative), path.read_text(encoding="utf8"))


def rename_path(source: Path, destination: Path) -> None:
    source.rename(destination)


def remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


def verify_installed_tree(generated: Path, package_root: Path) -> None:
    expected = {target for _, target in RUNTIME_MANIFEST}
    actual = {
        path.relative_to(package_root).as_posix()
        for root in GENERATED_ROOTS
        for path in (package_root / root).rglob("*")
        if path.is_file()
    }
    if actual != expected:
        raise RuntimeError(f"Installed generated resource verification failed: expected={sorted(expected)!r}, actual={sorted(actual)!r}")
    for relative in expected:
        installed = package_root / relative
        source = generated / relative
        if installed.read_bytes() != source.read_bytes():
            raise RuntimeError(f"Installed generated resource verification failed: byte mismatch for {relative}")


def rollback_installation(transaction: Path, package_root: Path, had_original: dict[str, bool], move, remove) -> list[str]:
    backups = transaction / "backups"
    staged = transaction / "staged"
    errors = []
    for root in reversed(GENERATED_ROOTS):
        destination = package_root / root
        backup = backups / root
        if backup.exists():
            try:
                if destination.exists():
                    remove(destination)
            except BaseException as error:
                errors.append(f"could not remove installed {root}: {error}")
                continue
            try:
                move(backup, destination)
            except BaseException as error:
                errors.append(f"could not restore backup {root}: {error}")
        elif not had_original[root] and destination.exists() and not (staged / root).exists():
            try:
                remove(destination)
            except BaseException as error:
                errors.append(f"could not remove newly installed {root}: {error}")
    if errors:
        return errors
    try:
        remove(transaction)
    except BaseException as first_cleanup_error:
        try:
            remove(transaction)
        except BaseException as second_cleanup_error:
            errors.append(f"could not clean rollback artifacts: {first_cleanup_error}; retry: {second_cleanup_error}")
    return errors


def install_generated_tree(temporary_root: Path, package_root: Path, move=rename_path, remove=remove_tree) -> None:
    transaction = None
    had_original = {root: (package_root / root).exists() for root in GENERATED_ROOTS}
    try:
        transaction = Path(tempfile.mkdtemp(prefix=".pi-git-spice-install-", dir=package_root))
        staged = transaction / "staged"
        backups = transaction / "backups"
        staged.mkdir()
        backups.mkdir()
        for root in GENERATED_ROOTS:
            shutil.copytree(temporary_root / root, staged / root)
        for root in GENERATED_ROOTS:
            destination = package_root / root
            if had_original[root]:
                move(destination, backups / root)
        for root in GENERATED_ROOTS:
            move(staged / root, package_root / root)
        verify_installed_tree(temporary_root, package_root)
    except BaseException as install_error:
        if transaction is None:
            raise
        rollback_errors = rollback_installation(transaction, package_root, had_original, move, remove)
        if rollback_errors:
            details = "; ".join(rollback_errors)
            raise RuntimeError(
                f"Failed to roll back generated resource installation: {details}. Recovery artifacts retained at: {transaction}"
            ) from install_error
        raise
    try:
        remove(transaction)
    except BaseException as cleanup_error:
        try:
            remove(transaction)
        except BaseException as retry_error:
            raise RuntimeError(
                f"Generated resource installation committed and verified, but cleanup failed: {cleanup_error}; retry: {retry_error}. "
                f"Recovery artifacts retained at: {transaction}"
            ) from cleanup_error
        raise RuntimeError(
            "Generated resource installation committed and verified, but cleanup was interrupted; transaction artifacts were removed"
        ) from cleanup_error


def main() -> None:
    args = parse_args()
    source = resolve_source_path(args)
    validate_source(source)
    temporary_root = Path(tempfile.mkdtemp(prefix="pi-git-spice-generated-"))
    try:
        generated = build_generated_tree(source, temporary_root)
        validate_generated_tree(generated)
        install_generated_tree(generated, PACKAGE_ROOT, move=rename_path, remove=remove_tree)
    except BaseException as operation_error:
        try:
            remove_tree(temporary_root)
        except BaseException as cleanup_error:
            raise RuntimeError(f"Failed to clean generated staging artifacts at {temporary_root}: {cleanup_error}") from operation_error
        raise
    try:
        remove_tree(temporary_root)
    except BaseException as cleanup_error:
        raise RuntimeError(f"Failed to clean committed generated staging artifacts at {temporary_root}: {cleanup_error}") from cleanup_error


if __name__ == "__main__":
    main()
