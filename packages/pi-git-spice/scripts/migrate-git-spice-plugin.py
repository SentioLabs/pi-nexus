#!/usr/bin/env python3
"""Regenerate Pi git-spice resources from the Claude plugin source."""

import argparse
from collections.abc import Mapping
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from types import MappingProxyType

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import migration_contracts as contracts
import migration_install as installer

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
REVIEWED_UPSTREAM_COMMIT = "c84eeae13b6b283f5969044fc6775e642e805935"
PINNED_SOURCE_SHA256 = {
    ".claude-plugin/plugin.json": "05a3bb20a09140dabb498f62e53e513bae64e92f4f6bd252944b4c14de5c4d75",
    "commands/continue.md": "36a2a0984affd272c80ee7264db39a760744cfb20e8d7900a91057fa56c76783",
    "commands/init.md": "f28579b31be7fb0aa0c101734359a8a2f7fab5e999d54b753b0a57767740841c",
    "commands/new.md": "773de81af3ea362b9006baf301296d1f76879cae2ee8378106b64752cab2fb44",
    "commands/restack.md": "51f361cc07d4803bd890e0d3eb857ace7225b18f684078b7ab275237defb5a67",
    "commands/stack.md": "07f06651c43e56a3328cad7950651775919ffe88ed0d235e2232d766ab2b0537",
    "commands/submit.md": "be232954a666a724b91a9da56fc77bb2c1ebf69191094990022388b0735f1199",
    "commands/sync.md": "b08b01431d3285bbc39267c778290ced498b31a3c0e1d6d383a68df640c51494",
    "skills/git-spice/SKILL.md": "6aef3f2dc87e8ddbfa94d231aa3201d69deae27616d7ba6090ae04c362dbf9a2",
    "skills/stacking-workflow/SKILL.md": "558461eb99a21cdd21d2cbc5b38c4fa97e8efa396861cb20c320edc6c16c32bf",
    "agents/stack-doctor.md": "d1afbff2da29e95f9645ee2c63f3888f7d875748a1766a2b06b624b145e9566e",
    "agents/stacker.md": "c5f7055f7b60d9ee5014d39fe7f28680a485a807bfb7f10bda06f58ff12c50e1",
}
if set(PINNED_SOURCE_SHA256) != set(REQUIRED_SOURCE_PATHS):
    raise RuntimeError("Pinned source digest keys must exactly match REQUIRED_SOURCE_PATHS")

GENERATED_ROOTS = tuple(sorted({Path(target).parts[0] for _, target in RUNTIME_MANIFEST}))
MANUAL_SUBPROCESS_COMMANDS = (
    "auth login",
    "commit split",
    "csp",
    "branch split",
    "bsp",
    "branch edit",
    "be",
    "stack edit",
    "se",
    "downstack edit",
    "dse",
)
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
    "<extra-flags>",
    "git-spice --no-prompt commit ...",
    "<paste git-spice --no-prompt log long>",
    "<paste git-spice --no-prompt log long and git status>",
) + tuple(f"git-spice --no-prompt {command}" for command in MANUAL_SUBPROCESS_COMMANDS)

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
    return next(
        (candidate.expanduser().resolve() for candidate in DEFAULT_SOURCE_CANDIDATES if candidate.exists()),
        DEFAULT_SOURCE_CANDIDATES[0].expanduser().resolve(),
    )


def reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError(f"Duplicate JSON key in source plugin.json: {key!r}")
        result[key] = value
    return result


def decode_source_bytes(raw: bytes, context: str | Path) -> str:
    try:
        return raw.decode("utf8")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"Source file is not valid UTF-8: {context}: {error}") from error


def validate_metadata(raw: bytes, metadata_path: Path) -> None:
    try:
        metadata = json.loads(decode_source_bytes(raw, metadata_path), object_pairs_hook=reject_duplicate_json_keys)
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


def load_validated_source(
    source: Path,
    expected_digests: Mapping[str, str],
) -> Mapping[str, bytes]:
    expected_digest_paths = set(expected_digests)
    required_paths = set(REQUIRED_SOURCE_PATHS)
    if expected_digest_paths != required_paths:
        missing_digest_paths = sorted(required_paths - expected_digest_paths)
        extra_digest_paths = sorted(expected_digest_paths - required_paths)
        raise RuntimeError(
            "Source digest keys must exactly match REQUIRED_SOURCE_PATHS; "
            f"missing={missing_digest_paths!r}, extra={extra_digest_paths!r}"
        )
    inventory = {
        path.relative_to(source).as_posix(): path
        for path in source.rglob("*")
        if path.is_file()
    }
    missing = [relative for relative in REQUIRED_SOURCE_PATHS if relative not in inventory]
    if missing:
        details = "\n".join(f"- {path}" for path in missing)
        raise RuntimeError(
            "Source plugin does not look like the Claude git-spice plugin:\n"
            f"Missing expected paths:\n{details}"
        )
    expected = required_paths | set(INTENTIONALLY_IGNORED_SOURCE_PATHS)
    unclassified = sorted(set(inventory) - expected)
    if unclassified:
        raise RuntimeError("Unclassified source file(s) would be omitted from pi-git-spice generation:\n" + "\n".join(f"- {path}" for path in unclassified))
    snapshot = MappingProxyType({relative: inventory[relative].read_bytes() for relative in REQUIRED_SOURCE_PATHS})
    drift = []
    for relative, raw in snapshot.items():
        expected_digest = expected_digests[relative]
        actual_digest = hashlib.sha256(raw).hexdigest()
        if actual_digest != expected_digest:
            drift.append(f"- {relative}: expected={expected_digest} actual={actual_digest}")
    if drift:
        raise RuntimeError("Source digest drift from reviewed upstream bytes:\n" + "\n".join(drift))
    validate_metadata(snapshot[SOURCE_METADATA_PATH], source / SOURCE_METADATA_PATH)
    for source_relative, _ in RUNTIME_MANIFEST:
        text = decode_source_bytes(snapshot[source_relative], source / source_relative)
        if source_relative.startswith("commands/"):
            parse_prompt_frontmatter(text, source_relative)
        elif source_relative.startswith("skills/"):
            validate_skill_frontmatter(text, Path(source_relative).parts[1], source_relative)
        else:
            _, expected_tools, _ = contracts.AGENT_CONFIG[source_relative]
            parse_agent_frontmatter(text, expected_tools, source_relative)
    return snapshot


def validate_source(
    source: Path,
    expected_digests: Mapping[str, str] = PINNED_SOURCE_SHA256,
) -> None:
    load_validated_source(source, expected_digests)
    return None


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


def validate_exact_transform_anchors(text: str, context: str) -> None:
    for source, _ in contracts.MANUAL_INTERACTIVE_TRANSFORMS.get(context, ()):
        actual = text.count(source)
        if actual != 1:
            raise RuntimeError(
                "Expected exactly 1 manual-interactive source anchor cardinality "
                f"while patching {context}, found {actual}: {source[:80]!r}"
            )
    for label, source, _, expected in contracts.EDITOR_OPENING_TRANSFORMS.get(context, ()):
        actual = text.count(source)
        if actual != expected:
            raise RuntimeError(
                f"Expected exactly {expected} {label} editor-opening anchor cardinality "
                f"while patching {context}, found {actual}"
            )


def validate_transformation_anchors(text: str, context: str) -> None:
    expected_mutations = contracts.EXPECTED_MUTATION_ANCHORS.get(context, {})
    for label in ("reset", "init", "branch create", "rebase continue", "rebase abort", "restack", "sync", "submit"):
        expected = expected_mutations.get(label, 0)
        actual = len(contracts.MUTATION_ANCHOR_PATTERNS[label].findall(text))
        if actual != expected:
            raise RuntimeError(f"Expected exactly {expected} {label} mutation anchor cardinality while patching {context}, found {actual}")
    expected_aliases = contracts.EXPECTED_ALIAS_ANCHORS.get(context, 0)
    aliases = len(contracts.ALIAS_ANCHOR_PATTERN.findall(text))
    if aliases != expected_aliases:
        raise RuntimeError(f"Expected exactly {expected_aliases} alias command anchor cardinality while patching {context}, found {aliases}")
    if context == "skills/git-spice/SKILL.md":
        for alias, expected in contracts.EXPECTED_ALIAS_NAMES.items():
            pattern = re.compile(rf"(?<![\w-])git-spice {re.escape(alias)}(?=\s|`|\))")
            actual = len(pattern.findall(text))
            if actual != expected:
                raise RuntimeError(f"Expected exactly {expected} {alias!r} alias command anchor cardinality while patching {context}, found {actual}")
    expected_commands = contracts.EXPECTED_COMMAND_ANCHORS[context]
    commands = len(contracts.COMMAND_ANCHOR_PATTERN.findall(text))
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
        contracts.COMMAND_ANCHOR_PATTERN,
        "git-spice --no-prompt",
        text,
        contracts.EXPECTED_COMMAND_ANCHORS[context],
        context,
        "command prefixes",
    )
    return checked_sub(
        contracts.ALIAS_ANCHOR_PATTERN,
        "git-spice --no-prompt",
        text,
        contracts.EXPECTED_ALIAS_ANCHORS.get(context, 0),
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


def apply_editor_opening_transforms(text: str, context: str) -> str:
    for _, source, target, _ in contracts.EDITOR_OPENING_TRANSFORMS.get(context, ()):
        text = text.replace(source, target)
    return text


def make_rebase_continuations_noninteractive(text: str, context: str) -> str:
    expected = contracts.EXPECTED_MUTATION_ANCHORS.get(context, {}).get("rebase continue", 0)
    pattern = re.compile(r"git-spice --no-prompt rebase continue(?!\s+--no-edit)")
    return checked_sub(pattern, "git-spice --no-prompt rebase continue --no-edit", text, expected, context, "rebase continue mutations")


def split_command_comment(arguments: str) -> tuple[str, str]:
    marker = arguments.find("#")
    if marker == -1 or (marker > 0 and arguments[marker - 1] not in " \t"):
        return arguments.strip(" \t"), ""
    return arguments[:marker].strip(" \t"), " # " + arguments[marker + 1:].strip()


def make_branch_creations_explicit(text: str, context: str) -> str:
    expected = contracts.EXPECTED_MUTATION_ANCHORS.get(context, {}).get("branch create", 0)
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
    mutations = contracts.EXPECTED_MUTATION_ANCHORS.get(context, {})
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
    expected = contracts.EXPECTED_MUTATION_ANCHORS.get(context, {}).get("submit", 0)
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
    expected = contracts.EXPECTED_MUTATION_ANCHORS.get(context, {}).get("sync", 0)
    pattern = re.compile(r"git-spice --no-prompt repo sync(?P<arguments>[^`\n]*)")

    def replacement(match: re.Match[str]) -> str:
        executable, comment = split_command_comment(match.group("arguments"))
        if not re.search(r"(?:^|\s)--restack(?:=\S+)?(?:\s|$)", executable):
            executable += " --restack"
        suffix = " " + executable.strip()
        return "git-spice --no-prompt repo sync" + suffix + comment

    return checked_sub(pattern, replacement, text, expected, context, "repo sync mutations")


def transform_executable_guidance(text: str, context: str) -> str:
    manual_transforms = contracts.MANUAL_INTERACTIVE_TRANSFORMS.get(context, ())
    text = apply_editor_opening_transforms(text, context)
    text = make_commands_noninteractive(text, context)
    text = make_alias_mutations_explicit(text, context)
    text = make_rebase_continuations_noninteractive(text, context)
    text = make_branch_creations_explicit(text, context)
    text = make_init_mutations_explicit(text, context)
    text = make_submit_drafts_explicit(text, context)
    text = make_sync_restack_explicit(text, context)
    for source, target in manual_transforms:
        generated_anchor = source.replace("git-spice ", "git-spice --no-prompt ")
        text = require_replace(text, generated_anchor, target, f"{context} manual-interactive output")
    return text


def transform_prompt(source_relative: str, text: str) -> str:
    if source_relative not in contracts.PROMPT_SAFETY_APPENDICES:
        raise RuntimeError(f"Unsupported source prompt: {source_relative}")
    fields, body = parse_prompt_frontmatter(text, source_relative)
    validate_exact_transform_anchors(body, source_relative)
    validate_transformation_anchors(body, source_relative)
    anchor = contracts.PROMPT_ANCHORS[source_relative]
    require_replace(body, anchor, anchor, source_relative)
    body = transform_prompt_references(body, source_relative)
    if source_relative == "commands/init.md":
        body = require_replace(
            body,
            (
                "3. Run `git-spice repo init`. If `$ARGUMENTS` was provided, treat it as either a trunk "
                "branch name or `--trunk=<name> --remote=<name>` flags and pass it through. Otherwise let "
                "the interactive prompt run."
            ),
            (
                "3. Resolve `$ARGUMENTS` to explicit `--trunk=<name> --remote=<name>` values. If either "
                "value is absent, gather it through an available user-question tool or plain chat; stop if "
                "it remains unavailable. Run `git-spice repo init --trunk=<name> --remote=<name>`."
            ),
            source_relative,
        )
    if source_relative == "commands/new.md":
        body = require_replace(
            body,
            (
                "1. Parse `$ARGUMENTS` as the branch name. If empty, ask the user for one (or note that "
                "git-spice will auto-generate from the commit message if `--no-commit` isn't used)."
            ),
            (
                "1. Parse `$ARGUMENTS` as the branch name. If empty, gather an explicit name through an "
                "available user-question tool or plain chat; stop if it remains unavailable."
            ),
            source_relative,
        )
    body = transform_executable_guidance(body, source_relative)
    if source_relative == "commands/submit.md":
        body = require_replace(
            body,
            "   - Remaining tokens are passed through as flags.",
            (
                "   - Accept only documented optional submit flags; reject prompt controls and draft controls "
                "that conflict with the resolved explicit draft state."
            ),
            source_relative,
        )
        body = require_replace(
            body,
            (
                "4. Then run the real submit: `git-spice --no-prompt <scope> submit --fill <draft-flag> "
                "<extra-flags>`. The `--fill` flag populates title/body from commit messages so the run is "
                "non-interactive."
            ),
            (
                "4. Reject prompt controls and conflicting draft controls, then run `git-spice --no-prompt "
                "<scope> submit --fill <draft-flag>`. The resolved draft state remains explicit. Documented "
                "optional submit flags may be included only after those checks. The `--fill` flag populates "
                "title/body from commit messages so the run is non-interactive."
            ),
            source_relative,
        )
    body = body.rstrip() + "\n\n" + contracts.PROMPT_SAFETY_APPENDICES[source_relative].rstrip()
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
    validate_exact_transform_anchors(body, context)
    validate_transformation_anchors(body, context)
    dispatch = "## Dispatching optional Pi subagents\n\n" + contracts.DISPATCH_CONTRACT
    body = replace_section(body, "## Dispatching the subagents", "## Configuration", dispatch, context)
    body = transform_prompt_references(body, context)
    body = require_replace(
        body,
        "Leave the inherently-interactive commands to the user.",
        "The inherently interactive command-map entries are terminal-only examples; do not execute them through Pi/tool subprocesses.",
        context,
    )
    body = transform_executable_guidance(body, context)
    body = require_replace(
        body,
        "> Prefer `git-spice --no-prompt commit ...` over raw `git commit` while inside a stack.",
        "> Prefer the concrete git-spice commit commands listed above over raw `git commit` while inside a stack.",
        context,
    )
    body = body.rstrip() + "\n\n" + contracts.INIT_SAFETY_CONTRACT.rstrip() + "\n\n" + contracts.SUBMIT_DRAFT_CONTRACT.rstrip()
    return "---\n" + frontmatter + "\n---\n\n" + body.rstrip() + "\n"


def transform_stacking_workflow(text: str) -> str:
    context = "skills/stacking-workflow/SKILL.md"
    normalized = validate_skill_frontmatter(text, "stacking-workflow", context)
    frontmatter, body = split_frontmatter(normalized, context)
    validate_exact_transform_anchors(body, context)
    validate_transformation_anchors(body, context)
    dispatch = "## Driving with optional Pi subagents\n\n" + contracts.DISPATCH_CONTRACT
    body = replace_section(body, "## Driving with subagents", "## Don't", dispatch, context)
    body = transform_prompt_references(body, context)
    body = transform_executable_guidance(body, context)
    body = body.rstrip() + "\n\n" + contracts.SUBMIT_DRAFT_CONTRACT.rstrip()
    return "---\n" + frontmatter + "\n---\n\n" + body.rstrip() + "\n"


def transform_agent(source_relative: str, text: str) -> str:
    name, expected_tools, anchor = contracts.AGENT_CONFIG[source_relative]
    description, tools, body = parse_agent_frontmatter(text, expected_tools, source_relative)
    validate_exact_transform_anchors(body, source_relative)
    validate_transformation_anchors(body, source_relative)
    require_replace(body, anchor, anchor, source_relative)
    if name == "stacker":
        body = require_replace(
            body,
            (
                "`git-spice branch create <prefix><slug>` (uses staged changes as the commit). The commit "
                "message defaults to the staged changes; if the task description maps to a clean "
                "conventional-commit subject, prefer `git-spice branch create <name> -m \"<subject>\"`."
            ),
            (
                "`git-spice branch create <prefix><slug> -m \"<subject>\"`. Gather the subject explicitly; "
                "use `git-spice branch create <name> -m \"<subject>\"` rather than relying on defaults or "
                "opening an editor."
            ),
            source_relative,
        )
    if name == "stack-doctor":
        body = require_replace(
            body,
            (
                "| Branches exist in git but not in `log long --all` | untracked | `git-spice branch "
                "track` per branch, or `git-spice downstack track` from the top |"
            ),
            (
                "| Branches exist in git but not in `log long --all` | untracked | Gather or derive each "
                "exact untracked branch name and the exact top branch name first. If branch names are "
                "ambiguous or missing configuration prevents deriving them, report it and stop rather than "
                "enabling prompts. Run `git-spice branch track <branch>` for each branch, or `git-spice "
                "downstack track <top-branch>` for whole-stack tracking. |"
            ),
            source_relative,
        )
    body = transform_executable_guidance(body, source_relative)
    if name == "stacker":
        body = require_replace(
            body,
            "<paste git-spice --no-prompt log long>",
            "<paste final stack log output>",
            source_relative,
        )
    if name == "stack-doctor":
        body = require_replace(
            body,
            "<paste git-spice --no-prompt log long and git status>",
            "<paste final stack log and git status output>",
            source_relative,
        )
        body = body.rstrip() + "\n\n" + contracts.INIT_SAFETY_CONTRACT.rstrip() + "\n\n" + contracts.SUBMIT_DRAFT_CONTRACT.rstrip()
    tool_names = ", ".join(contracts.TOOL_MAP[tool] for tool in tools)
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


def build_generated_tree(source_snapshot: Mapping[str, bytes], temporary_root: Path) -> Path:
    generated = temporary_root / "generated"
    for source_relative, target_relative in RUNTIME_MANIFEST:
        text = decode_source_bytes(source_snapshot[source_relative], source_relative)
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
    for relative, literal_contracts in contracts.REQUIRED_GENERATED_LITERALS.items():
        text = (temporary_root / relative).read_text(encoding="utf8")
        for literal, expected_count in literal_contracts:
            actual_count = text.count(literal)
            if actual_count != expected_count:
                raise RuntimeError(
                    f"Generated required literal cardinality mismatch for {relative}: "
                    f"expected={expected_count}, actual={actual_count}, literal={literal!r}"
                )
    for relative, transforms in contracts.MANUAL_INTERACTIVE_TRANSFORMS.items():
        text = (temporary_root / dict(RUNTIME_MANIFEST)[relative]).read_text(encoding="utf8")
        for _, target in transforms:
            if text.count(target) != 1:
                raise RuntimeError(
                    f"Generated manual-interactive literal cardinality mismatch for {relative}: {target!r}"
                )


def rename_path(source: Path, destination: Path) -> None:
    source.rename(destination)


def remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


def install_generated_tree(
    temporary_root: Path,
    package_root: Path,
    move=rename_path,
    remove=remove_tree,
) -> None:
    expected = {target for _, target in RUNTIME_MANIFEST}
    installer.install_generated_tree(
        temporary_root,
        package_root,
        GENERATED_ROOTS,
        expected,
        move,
        remove,
    )


def migrate(
    source: Path,
    package_root: Path = PACKAGE_ROOT,
    expected_digests: Mapping[str, str] = PINNED_SOURCE_SHA256,
) -> None:
    source_snapshot = load_validated_source(source, expected_digests)
    temporary_root = Path(tempfile.mkdtemp(prefix="pi-git-spice-generated-"))
    try:
        generated = build_generated_tree(source_snapshot, temporary_root)
        validate_generated_tree(generated)
        install_generated_tree(generated, package_root, move=rename_path, remove=remove_tree)
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


def main() -> None:
    source = resolve_source_path(parse_args())
    migrate(source, PACKAGE_ROOT, PINNED_SOURCE_SHA256)


if __name__ == "__main__":
    main()
