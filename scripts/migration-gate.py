#!/usr/bin/env python3
"""Schema gate of the prebuilt-image deploy: may this release's migrations activate unattended?

deploy-prebuilt-image.sh runs `check` before any backup or restart. When
src/database/migrations.ts is byte-identical in the running container and the release image there
is nothing to decide. Otherwise the release activates automatically only when every difference is
a new migration entry appended after the shipped ones, the database (read through the running
container) does not record it yet, and its docs/reference/migrations/<name>.md shipped in the
release image carries the front matter below with "rollback-compatible: yes" and
"data-deletion: no". A release that then fails verification is rolled back to the old image,
which has to work on a database the release may already have migrated.

    ---
    migration: <name>
    rollback-compatible: yes|no
    data-deletion: yes|no
    ---
    <non-empty body; a "## Rollback" section when rollback-compatible is no>

The operator of a reviewed migration procedure can accept what the gate cannot judge on its own
by naming the one transition it reviewed, "<running sha256>:<release sha256>" of migrations.ts:
a risky declaration, a change to code outside the migration entries, or a migration the database
already records while the running image lacks it (after an image rollback). The override never
accepts what it cannot attest to: a missing or invalid doc, an edited, renamed, removed or
reordered shipped entry (the runner will never run the edit), a migrations.ts that cannot be
read or parsed, a release whose exported migration list differs from its source entries, or
input the gate could not read.

`check` prints one "SCHEMA_GATE decision=..." audit line and exits 0, or prints the refusals on
stderr and exits 1. It writes the names of accepted migrations that do not declare
"rollback-compatible: yes" to the rollback guard file; `unapplied` then tells the failed-deploy
path whether the database records none of them, so the old image may start on it.

Usage: migration-gate.py check <container> <release image> <reviewed transition> <guard file>
       migration-gate.py unapplied <old image> <data dir> <guard file>
"""

from dataclasses import dataclass, field
import hashlib
import io
import re
import subprocess
import sys
import tarfile

MIGRATIONS_PATH = "/app/src/database/migrations.ts"
DOCS_DIR = "docs/reference/migrations"
# Read-only: the names the database's migration runner has recorded, oldest first.
APPLIED_MIGRATIONS_JS = """
import { Database } from 'bun:sqlite';
const db = new Database(process.env.DATABASE_PATH || './data/calendar.db', { readonly: true });
try {
  for (const row of db.query('SELECT name FROM migrations ORDER BY id').all()) console.log(row.name);
} finally {
  db.close();
}
"""
# The list the release's runner will actually iterate, whatever the source text looks like.
EXPORTED_MIGRATIONS_JS = """
const { migrations } = await import('/app/src/database/migrations.ts');
for (const migration of migrations) console.log(migration.name);
"""

# Each top-level entry starts right after the array opener or the previous entry's comma with
# "\n  {\n    name: '". Requiring "[" or "," keeps entry-shaped text inside a body (a comment,
# a seed-data literal) from being cut out as a phantom entry.
ENTRY_BOUNDARY = re.compile(r"(?<=[\[,])(?=\n  \{\n    name: ')")
ENTRY_NAME = re.compile(r"\n  \{\n    name: '([A-Za-z0-9_]+)',\n")
# Every object literal whose first key is `name`, whatever quoting, spacing or value follows. A
# boundary the strict split misses (an entry named by a constant, a template or a reindent) is
# still counted here, so the counts diverge instead of the entry vanishing into its neighbour.
ANY_ENTRY_START = re.compile(r"(?<=[\[,])\s*\{\s*name\s*:")
# The array closes at the file's last line starting with "];". A line like that inside the last
# entry (a multi-line template literal) then stays in that entry, so an edit below it is an edit
# of a shipped migration, never a change to the code outside the entries.
ARRAY_END = "\n];"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class ParsedMigrations:
    names: tuple[str, ...]
    digests: dict[str, str]
    # Digest of everything outside the entries: header, imports and any code before the array
    # opener, plus the array close and anything after it.
    outside: str


def parse_migrations(text: str) -> ParsedMigrations:
    parts = ENTRY_BOUNDARY.split(text)
    preamble, entries = parts[0], parts[1:]
    if not entries:
        raise ValueError("no migration entry found")
    end = entries[-1].rfind(ARRAY_END)
    if end < 0:
        raise ValueError("the migrations array has no closing line '];'")
    trailer = entries[-1][end:]
    # Cut the close off the last entry so that appending one never changes its predecessor.
    entries[-1] = entries[-1][:end]
    digests: dict[str, str] = {}
    for entry in entries:
        match = ENTRY_NAME.match(entry)
        if not match:
            name_line = entry.split("\n", 3)[2].strip()
            raise ValueError(
                f"migration entry {name_line!r}: the name must be one single-quoted "
                "[A-Za-z0-9_] literal alone on its line"
            )
        name = match.group(1)
        if name in digests:
            raise ValueError(f"duplicate migration name {name}")
        digests[name] = sha256(entry.encode())
    expected = len(ANY_ENTRY_START.findall(text))
    if len(digests) != expected:
        raise ValueError(
            f"parsed {len(digests)} migration entries but found {expected} objects starting with a "
            "name key; the file's shape has drifted from what this parser expects"
        )
    return ParsedMigrations(tuple(digests), digests, sha256(preamble.encode() + b"\0" + trailer.encode()))


@dataclass(frozen=True)
class DocContract:
    rollback_compatible: bool
    data_deletion: bool
    sha256: str


def parse_doc(raw: bytes, name: str) -> DocContract:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("the doc is not UTF-8") from error
    if not text.strip():
        raise ValueError("the doc is empty")
    lines = text.split("\n")
    front = lines[:5]
    if (
        len(front) < 5
        or front[0] != "---"
        or front[1] != f"migration: {name}"
        or front[2] not in ("rollback-compatible: yes", "rollback-compatible: no")
        or front[3] not in ("data-deletion: yes", "data-deletion: no")
        or front[4] != "---"
    ):
        raise ValueError(
            f"the doc must start with the front matter lines '---', 'migration: {name}', "
            "'rollback-compatible: yes|no', 'data-deletion: yes|no', '---'"
        )
    body = "\n".join(lines[5:])
    if not body.strip():
        raise ValueError("the doc has nothing after its front matter")
    rollback_compatible = front[2].endswith("yes")
    if not rollback_compatible and not re.search(r"^## Rollback$", body, re.MULTILINE):
        raise ValueError("a doc declaring rollback-compatible: no needs a '## Rollback' section")
    return DocContract(rollback_compatible, front[3].endswith("yes"), sha256(raw))


@dataclass(frozen=True)
class NewMigration:
    name: str
    doc: DocContract | None
    # Recorded in the database already although the running image lacks it (after an image rollback).
    applied: bool = False

    @property
    def doc_path(self) -> str:
        return f"{DOCS_DIR}/{self.name}.md"


@dataclass
class Decision:
    running_sha256: str
    release_sha256: str
    migrations: list[NewMigration] = field(default_factory=list)
    refusals: list[str] = field(default_factory=list)
    # A refusal the reviewed transition cannot override.
    final: bool = False
    mode: str = "refused"

    def require_review(self, reason: str) -> None:
        self.refusals.append(reason)

    def refuse(self, reason: str) -> None:
        self.refusals.append(reason)
        self.final = True

    @property
    def accepted(self) -> bool:
        return self.mode != "refused"

    @property
    def rollback_guard(self) -> list[str]:
        """Accepted new migrations the old image is not declared to survive (it already runs on applied ones)."""
        return [m.name for m in self.migrations if not m.applied and (m.doc is None or not m.doc.rollback_compatible)]

    def audit_line(self) -> str:
        if self.mode == "unchanged":
            return f"SCHEMA_GATE decision=unchanged migrations_sha256={self.release_sha256}"
        line = f"SCHEMA_GATE decision={self.mode} from={self.running_sha256} to={self.release_sha256}"
        for migration in self.migrations:
            doc = migration.doc
            line += f" migration={migration.name} doc={migration.doc_path}"
            if doc is not None:
                line += (
                    f" doc_sha256={doc.sha256}"
                    f" rollback-compatible={'yes' if doc.rollback_compatible else 'no'}"
                    f" data-deletion={'yes' if doc.data_deletion else 'no'}"
                )
        return line


def decide(
    running: bytes | None,
    release: bytes | None,
    applied: list[str] | None,
    exported: list[str] | None,
    docs: dict[str, bytes] | None,
    reviewed_transition: str,
) -> Decision:
    for side, raw in (("running container", running), ("release image", release)):
        if not raw:
            decision = Decision("", "")
            decision.refuse(f"migrations.ts {'could not be read' if raw is None else 'is empty'} in the {side}")
            return decision
    decision = Decision(sha256(running), sha256(release))
    if decision.running_sha256 == decision.release_sha256:
        decision.mode = "unchanged"
        return decision

    def parse(side: str, raw: bytes) -> ParsedMigrations | None:
        try:
            return parse_migrations(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            decision.refuse(f"the {side} migrations.ts cannot be parsed: {error}")
            return None

    old, new = parse("running", running), parse("release", release)
    if new is not None and exported is None:
        decision.refuse("the release image's exported migration list could not be read")
    elif new is not None and list(new.names) != exported:
        decision.refuse(f"the release exports migrations {exported} but its source entries are {list(new.names)}")
    if applied is None:
        decision.refuse("the database's applied migrations could not be read through the running container")
    if docs is None:
        decision.refuse(f"the release image's {DOCS_DIR} could not be read")
    if old is None or new is None or applied is None or docs is None:
        return finish(decision, reviewed_transition)

    if old.outside != new.outside:
        decision.require_review("migrations.ts code outside the migration entries changed; no migration doc can vouch for it")
    missing = [name for name in old.names if name not in new.digests]
    for name in missing:
        decision.refuse(f"migration {name} is missing from the release; a shipped migration is never renamed or removed")
    for name in old.names:
        if name in new.digests and old.digests[name] != new.digests[name]:
            decision.refuse(f"migration {name} changed after it shipped; the runner never re-runs an applied migration")
    if not missing and new.names[: len(old.names)] != old.names:
        decision.refuse(f"new migrations must follow the shipped ones; the release order is {list(new.names)}")
    recorded = set(applied)
    for name in new.names:
        applied_already = name in recorded
        if applied_already and name in old.digests:
            continue
        if applied_already:
            decision.require_review(
                f"migration {name} is already applied in the database but the running image does not "
                "carry it (an image rollback?); the runner will not run the release's version"
            )
        raw = docs.get(f"{name}.md")
        migration = NewMigration(name, None, applied_already)
        if raw is None:
            decision.refuse(f"migration {name} has no reviewed doc: {migration.doc_path}")
        else:
            try:
                migration = NewMigration(name, parse_doc(raw, name), applied_already)
            except ValueError as error:
                decision.refuse(f"migration {name}: {migration.doc_path} is not a valid migration doc: {error}")
        if migration.doc is not None and not migration.doc.rollback_compatible:
            decision.require_review(f"migration {name} declares rollback-compatible: no; the old image cannot run on its result")
        if migration.doc is not None and migration.doc.data_deletion:
            decision.require_review(f"migration {name} declares data-deletion: yes")
        decision.migrations.append(migration)
    if not decision.refusals and not decision.migrations:
        # The split is lossless, so a byte difference always lands in a check above; stay closed if not.
        decision.refuse("migrations.ts changed but no new migration entry could be identified")
    return finish(decision, reviewed_transition)


def finish(decision: Decision, reviewed_transition: str) -> Decision:
    if not decision.refusals:
        decision.mode = "automatic"
    elif not decision.final and reviewed_transition == f"{decision.running_sha256}:{decision.release_sha256}":
        decision.mode = "reviewed-override"
    return decision


def read(args: list[str]) -> bytes | None:
    """Stdout of a successful command, None otherwise; the command's stderr goes to the deploy log."""
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"schema gate: {args[:3]} failed: {error}", file=sys.stderr)
        return None
    return result.stdout if result.returncode == 0 else None


def lines(raw: bytes | None) -> list[str] | None:
    return None if raw is None else [line for line in raw.decode("utf-8", "replace").splitlines() if line]


def read_docs(raw: bytes | None) -> dict[str, bytes] | None:
    """Regular files directly inside migrations/ of a tar stream, by file name."""
    if raw is None:
        return None
    docs: dict[str, bytes] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            for member in archive:
                match = re.fullmatch(r"(?:\./)?migrations/([A-Za-z0-9_]+\.md)", member.name)
                extracted = archive.extractfile(member) if match and member.isfile() else None
                if match and extracted is not None:
                    docs[match.group(1)] = extracted.read()
    except tarfile.TarError as error:
        print(f"schema gate: unreadable migration docs archive: {error}", file=sys.stderr)
        return None
    return docs


def check(container: str, image: str, reviewed_transition: str, guard_path: str) -> int:
    in_release = ["docker", "run", "--rm", "--network", "none", "--entrypoint"]
    running = read(["docker", "exec", container, "cat", MIGRATIONS_PATH])
    release = read(in_release + ["cat", image, MIGRATIONS_PATH])
    if running and running == release:
        decision = decide(running, release, None, None, None, reviewed_transition)
    else:
        decision = decide(
            running,
            release,
            lines(read(["docker", "exec", container, "bun", "-e", APPLIED_MIGRATIONS_JS])),
            lines(read(in_release + ["bun", image, "-e", EXPORTED_MIGRATIONS_JS])),
            read_docs(read(in_release + ["tar", image, "-C", "/app/docs/reference", "-cf", "-", "migrations"])),
            reviewed_transition,
        )
    out = sys.stdout if decision.accepted else sys.stderr
    for refusal in decision.refusals:
        print(f"Schema gate refusal: {refusal}", file=out)
    if not decision.accepted:
        if decision.running_sha256 and not decision.final:
            print(
                "Schema gate: a reviewed migration procedure may accept exactly this transition with "
                f"HYPERCAL_REVIEWED_SCHEMA_TRANSITION={decision.running_sha256}:{decision.release_sha256}",
                file=sys.stderr,
            )
        return 1
    with open(guard_path, "w", encoding="utf-8") as guard:
        guard.write("".join(f"{name}\n" for name in decision.rollback_guard))
    print(decision.audit_line(), flush=True)
    return 0


def unapplied(old_image: str, data_dir: str, guard_path: str) -> int:
    """0 when the database records none of the guarded migrations; read by the old image itself."""
    with open(guard_path, encoding="utf-8") as guard:
        guarded = set(guard.read().split())
    recorded = lines(
        read(
            ["docker", "run", "--rm", "--network", "none", "-v", f"{data_dir}:/app/data"]
            + ["--entrypoint", "bun", old_image, "-e", APPLIED_MIGRATIONS_JS]
        )
    )
    if recorded is None:
        print("schema gate: the database's applied migrations could not be read", file=sys.stderr)
        return 1
    found = sorted(guarded.intersection(recorded))
    if found:
        print(f"schema gate: the database records {', '.join(found)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    commands = {"check": (check, 4), "unapplied": (unapplied, 3)}
    command = commands.get(sys.argv[1] if len(sys.argv) > 1 else "")
    if command is None or len(sys.argv) != command[1] + 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(command[0](*sys.argv[2:]))
