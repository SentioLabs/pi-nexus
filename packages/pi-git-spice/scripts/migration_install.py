"""Atomic installation transaction for generated git-spice resources."""

from pathlib import Path
import shutil
import tempfile
from typing import Callable

MovePath = Callable[[Path, Path], None]
RemoveTree = Callable[[Path], None]


def verify_installed_tree(
    generated: Path,
    package_root: Path,
    roots: tuple[str, ...],
    expected: set[str],
) -> None:
    actual = {
        path.relative_to(package_root).as_posix()
        for root in roots
        for path in (package_root / root).rglob("*")
        if path.is_file()
    }
    if actual != expected:
        raise RuntimeError(
            f"Installed generated resource verification failed: expected={sorted(expected)!r}, "
            f"actual={sorted(actual)!r}"
        )
    for relative in expected:
        installed = package_root / relative
        source = generated / relative
        if installed.read_bytes() != source.read_bytes():
            raise RuntimeError(
                f"Installed generated resource verification failed: byte mismatch for {relative}"
            )


def rollback_installation(
    transaction: Path,
    package_root: Path,
    roots: tuple[str, ...],
    had_original: dict[str, bool],
    move: MovePath,
    remove: RemoveTree,
) -> list[str]:
    backups = transaction / "backups"
    staged = transaction / "staged"
    errors = []
    for root in reversed(roots):
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
            errors.append(
                "could not clean rollback artifacts: "
                f"{first_cleanup_error}; retry: {second_cleanup_error}"
            )
    return errors


def install_generated_tree(
    generated: Path,
    package_root: Path,
    roots: tuple[str, ...],
    expected: set[str],
    move: MovePath,
    remove: RemoveTree,
) -> None:
    transaction = None
    had_original = {root: (package_root / root).exists() for root in roots}
    try:
        transaction = Path(tempfile.mkdtemp(prefix=".pi-git-spice-install-", dir=package_root))
        staged = transaction / "staged"
        backups = transaction / "backups"
        staged.mkdir()
        backups.mkdir()
        for root in roots:
            shutil.copytree(generated / root, staged / root)
        for root in roots:
            destination = package_root / root
            if had_original[root]:
                move(destination, backups / root)
        for root in roots:
            move(staged / root, package_root / root)
        verify_installed_tree(generated, package_root, roots, expected)
    except BaseException as install_error:
        if transaction is None:
            raise
        rollback_errors = rollback_installation(
            transaction,
            package_root,
            roots,
            had_original,
            move,
            remove,
        )
        if rollback_errors:
            details = "; ".join(rollback_errors)
            raise RuntimeError(
                f"Failed to roll back generated resource installation: {details}. "
                f"Recovery artifacts retained at: {transaction}"
            ) from install_error
        raise
    try:
        remove(transaction)
    except BaseException as cleanup_error:
        try:
            remove(transaction)
        except BaseException as retry_error:
            raise RuntimeError(
                "Generated resource installation committed and verified, but cleanup failed: "
                f"{cleanup_error}; retry: {retry_error}. Recovery artifacts retained at: {transaction}"
            ) from cleanup_error
        raise RuntimeError(
            "Generated resource installation committed and verified, but cleanup was interrupted; "
            "transaction artifacts were removed"
        ) from cleanup_error
