#!/usr/bin/env python3
"""Regenerate Pi git-spice resources from the Claude plugin source."""

import argparse
import json
from pathlib import Path
import re
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

For unattended continuation, use `git-spice --no-prompt rebase continue --no-edit`. Interactive commit-message editing is terminal-only; do not open an editor through Pi.
""",
    "commands/init.md": """## Pi execution safety

Do not run argumentless initialization in Pi. Gather an explicit trunk and remote through an available user-question tool, or through plain chat when that tool is unavailable; if either value is unavailable, stop. Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. For `--reset`, disclose that tracking relationships are forgotten and obtain a separate explicit confirmation before adding `--reset`.
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

Resolve `--draft` or `--no-draft` from arguments, then `spice.submit.draft`, then an available user-question tool or plain chat; stop if no value is available. Use the resolved flag for both `git-spice --no-prompt <scope> submit --dry-run --fill <draft-flag>` and `git-spice --no-prompt <scope> submit --fill <draft-flag> <extra-flags>`. Do not enable prompts for missing configuration.
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


def validate_metadata(source: Path) -> None:
    metadata_path = source / SOURCE_METADATA_PATH
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf8"))
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
        if not isinstance(metadata[key], str) or not metadata[key]:
            raise RuntimeError(f"Source plugin.json {key} must be a non-empty string: {metadata_path}")
    if metadata["name"] != "git-spice":
        raise RuntimeError(f"Source plugin.json name must be 'git-spice', got {metadata['name']!r}: {metadata_path}")
    if metadata["license"] != "MIT":
        raise RuntimeError(f"Source plugin.json license must be 'MIT', got {metadata['license']!r}: {metadata_path}")
    author = metadata["author"]
    if not isinstance(author, dict) or set(author) != {"name", "url"} or not all(isinstance(author[key], str) and author[key] for key in author):
        raise RuntimeError(f"Source plugin.json author must have non-empty string name and url fields: {metadata_path}")
    if not isinstance(metadata["keywords"], list) or not all(isinstance(keyword, str) for keyword in metadata["keywords"]):
        raise RuntimeError(f"Source plugin.json keywords must be a string array: {metadata_path}")


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
    lines = frontmatter.splitlines()
    if not lines or not lines[0].startswith("description: "):
        raise RuntimeError(f"Source agent description must be a non-empty scalar while patching {context}")
    description = lines[0].removeprefix("description: ").strip()
    if not description:
        raise RuntimeError(f"Source agent description must be a non-empty scalar while patching {context}")
    if len(lines) < 4 or lines[1] != "tools:":
        raise RuntimeError(f"Unsupported source agent frontmatter shape while patching {context}")
    tools = []
    index = 2
    while index < len(lines) and lines[index].startswith("  - "):
        tool = lines[index].removeprefix("  - ").strip()
        if not tool:
            raise RuntimeError(f"Malformed source agent tool while patching {context}")
        tools.append(tool)
        index += 1
    if index != len(lines) - 1 or lines[index] != "model: sonnet":
        raise RuntimeError(f"Source agent model must be exactly 'model: sonnet' while patching {context}")
    if tools != expected_source_tools:
        raise RuntimeError(f"Source agent tools must exactly match {expected_source_tools!r} while patching {context}")
    if len(set(tools)) != len(tools):
        raise RuntimeError(f"Duplicate source agent tool while patching {context}")
    return description, tools, body


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


def make_commands_noninteractive(text: str) -> str:
    command = r"(?:repo|auth|log|branch|commit|upstack|downstack|stack|rebase|trunk|top|bottom|up|down|<scope>)"
    return re.sub(
        rf"(?<![\w-])git-spice(?! --no-prompt)(?= {command}(?:\s|`|$))",
        "git-spice --no-prompt",
        text,
    )


def make_rebase_continuations_noninteractive(text: str) -> str:
    return re.sub(
        r"git-spice(?: --no-prompt)? rebase continue(?!\s+--no-edit)",
        "git-spice --no-prompt rebase continue --no-edit",
        text,
    )


def make_branch_creations_explicit(text: str) -> str:
    def explicit_command(command: str, arguments: str) -> str:
        arguments = arguments.strip()
        executable, marker, comment = arguments.partition(" #")
        if not executable:
            executable = '<name> -m "<message>"'
        elif not re.search(r"(?:^|\s)(?:-m|--message)(?:\s|=)", executable) and "--no-commit" not in executable:
            executable += ' -m "<message>"'
        return command + " " + executable + (marker + comment if marker else "")

    def replace_inline_command(match: re.Match[str]) -> str:
        return "`" + explicit_command(match.group(1), match.group(2)) + "`"

    def replace_line_command(match: re.Match[str]) -> str:
        return match.group(1) + explicit_command(match.group(2), match.group(3))

    text = re.sub(r"`(git-spice --no-prompt branch create)([^`]*)`", replace_inline_command, text)
    return re.sub(
        r"(?m)^(\s*)(git-spice --no-prompt branch create)([^\n]*)$",
        replace_line_command,
        text,
    )


def make_submit_mutations_noninteractive(text: str) -> str:
    return re.sub(
        r"git-spice(?: --no-prompt)? ((?:branch|upstack|downstack|stack|<scope>) submit)",
        r"git-spice --no-prompt \1",
        text,
    )


def make_stack_doctor_submit_drafts_explicit(text: str) -> str:
    def replace_command(match: re.Match[str]) -> str:
        command = match.group(1)
        arguments = match.group(2).strip()
        if not arguments:
            return f"`{command}`"
        if not re.search(r"(?:^|\s)(?:--draft|--no-draft|<draft-flag>)(?:\s|$)", arguments):
            arguments += " <draft-flag>"
        return f"`{command} {arguments}`"

    return re.sub(
        r"`(git-spice --no-prompt (?:branch|upstack|downstack|stack|<scope>) submit)([^`]*)`",
        replace_command,
        text,
    )


def transform_executable_guidance(text: str) -> str:
    text = make_commands_noninteractive(text)
    text = make_submit_mutations_noninteractive(text)
    text = make_rebase_continuations_noninteractive(text)
    return make_branch_creations_explicit(text)


def transform_prompt(source_relative: str, text: str) -> str:
    if source_relative not in PROMPT_SAFETY_APPENDICES:
        raise RuntimeError(f"Unsupported source prompt: {source_relative}")
    fields, body = parse_prompt_frontmatter(text, source_relative)
    anchor = PROMPT_ANCHORS[source_relative]
    require_replace(body, anchor, anchor, source_relative)
    body = transform_prompt_references(body, source_relative)
    body = transform_executable_guidance(body)
    if source_relative == "commands/init.md":
        body = require_replace(
            body,
            "`git-spice --no-prompt repo init --reset`",
            "`git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`",
            source_relative,
        )
        body = require_replace(
            body,
            "3. Run `git-spice --no-prompt repo init`. If `$ARGUMENTS` was provided, treat it as either a trunk branch name or `--trunk=<name> --remote=<name>` flags and pass it through. Otherwise let the interactive prompt run.",
            "3. Resolve `$ARGUMENTS` to explicit `--trunk=<name> --remote=<name>` values. If either value is absent, gather it through an available user-question tool or plain chat; stop if it remains unavailable. Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`.",
            source_relative,
        )
    if source_relative == "commands/new.md":
        body = require_replace(
            body,
            "1. Parse `$ARGUMENTS` as the branch name. If empty, ask the user for one (or note that git-spice will auto-generate from the commit message if `--no-commit` isn't used).",
            "1. Parse `$ARGUMENTS` as the branch name. If empty, gather an explicit name through an available user-question tool or plain chat; stop if it remains unavailable.",
            source_relative,
        )
    if source_relative == "commands/submit.md":
        body = re.sub(
            r"(git-spice --no-prompt <scope> submit --dry-run --fill)(?!\s+<draft-flag>)",
            r"\1 <draft-flag>",
            body,
        )
        body = re.sub(
            r"(git-spice --no-prompt <scope> submit --fill)(?!\s+<draft-flag>)",
            r"\1 <draft-flag>",
            body,
        )
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
    normalized = validate_skill_frontmatter(text, "git-spice", "skills/git-spice/SKILL.md")
    frontmatter, body = split_frontmatter(normalized, "skills/git-spice/SKILL.md")
    body = replace_section(body, "## Dispatching the subagents", "## Configuration", "## Dispatching optional Pi subagents\n\n" + DISPATCH_CONTRACT, "skills/git-spice/SKILL.md")
    body = transform_prompt_references(body, "skills/git-spice/SKILL.md")
    body = transform_executable_guidance(body)
    body = require_replace(body, "`git-spice bc`", "`bc`", "skills/git-spice/SKILL.md")
    body = require_replace(body, "`git-spice rbc`", "`rbc`", "skills/git-spice/SKILL.md")
    return "---\n" + frontmatter + "\n---\n\n" + body.rstrip() + "\n"


def transform_stacking_workflow(text: str) -> str:
    normalized = validate_skill_frontmatter(text, "stacking-workflow", "skills/stacking-workflow/SKILL.md")
    frontmatter, body = split_frontmatter(normalized, "skills/stacking-workflow/SKILL.md")
    body = replace_section(body, "## Driving with subagents", "## Don't", "## Driving with optional Pi subagents\n\n" + DISPATCH_CONTRACT, "skills/stacking-workflow/SKILL.md")
    body = transform_prompt_references(body, "skills/stacking-workflow/SKILL.md")
    body = transform_executable_guidance(body)
    return "---\n" + frontmatter + "\n---\n\n" + body.rstrip() + "\n"


def transform_agent(source_relative: str, text: str) -> str:
    name, expected_tools, anchor = AGENT_CONFIG[source_relative]
    description, tools, body = parse_agent_frontmatter(text, expected_tools, source_relative)
    require_replace(body, anchor, anchor, source_relative)
    if name == "stacker":
        body = require_replace(
            body,
            "`git-spice branch create <prefix><slug>` (uses staged changes as the commit). The commit message defaults to the staged changes; if the task description maps to a clean conventional-commit subject, prefer `git-spice branch create <name> -m \"<subject>\"`.",
            "`git-spice branch create <prefix><slug> -m \"<subject>\"`. Gather the subject explicitly; do not rely on defaults or open an editor.",
            source_relative,
        )
    if name == "stack-doctor":
        body = require_replace(
            body,
            "## Repair principles",
            "## Submit safety\n\nFor any submit repair, resolve an explicit `--draft` or `--no-draft` state before running the command. Never rely on an implicit draft state; stop and report missing configuration instead of enabling prompts.\n\n## Repair principles",
            source_relative,
        )
    body = transform_executable_guidance(body)
    if name == "stack-doctor":
        body = make_stack_doctor_submit_drafts_explicit(body)
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


def rename_path(source: Path, destination: Path) -> None:
    source.rename(destination)


def remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


def install_generated_tree(temporary_root: Path, package_root: Path, move=rename_path, remove=remove_tree) -> None:
    transaction = Path(tempfile.mkdtemp(prefix=".pi-git-spice-install-", dir=package_root))
    staged = transaction / "staged"
    backups = transaction / "backups"
    staged.mkdir()
    backups.mkdir()
    for root in GENERATED_ROOTS:
        shutil.copytree(temporary_root / root, staged / root)
    backed_up: list[str] = []
    installed: list[str] = []
    try:
        for root in GENERATED_ROOTS:
            destination = package_root / root
            if destination.exists():
                move(destination, backups / root)
                backed_up.append(root)
        for root in GENERATED_ROOTS:
            move(staged / root, package_root / root)
            installed.append(root)
    except BaseException as install_error:
        rollback_errors = []
        for root in reversed(installed):
            try:
                remove(package_root / root)
            except BaseException as error:
                rollback_errors.append(str(error))
        for root in reversed(backed_up):
            try:
                backup = backups / root
                if backup.exists():
                    move(backup, package_root / root)
            except BaseException as error:
                rollback_errors.append(str(error))
        try:
            remove(transaction)
        except BaseException as error:
            rollback_errors.append(str(error))
        if rollback_errors:
            details = "; ".join(rollback_errors)
            raise RuntimeError(f"Failed to roll back generated resource installation: {details}") from install_error
        raise
    remove(transaction)


def main() -> None:
    args = parse_args()
    source = resolve_source_path(args)
    validate_source(source)
    temporary_root = Path(tempfile.mkdtemp(prefix="pi-git-spice-generated-"))
    try:
        generated = build_generated_tree(source, temporary_root)
        validate_generated_tree(generated)
        install_generated_tree(generated, PACKAGE_ROOT, move=rename_path, remove=remove_tree)
    finally:
        remove_tree(temporary_root)


if __name__ == "__main__":
    main()
