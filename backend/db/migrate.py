"""Minimal, dependency-free-beyond-psycopg SQL migration runner.

No Alembic/SQLAlchemy: the project's migrations are numbered, plain SQL
files applied in order and tracked in a `schema_migrations` table so a
re-run only applies what's new. This is intentionally small — the stack
table in CLAUDE.md commits to Postgres, not to a specific migration
framework, and raw SQL keeps the schema legible without an ORM's
indirection for what is currently five small tables.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def _ensure_migrations_table(conn: psycopg.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )


def pending_migrations(conn: psycopg.Connection) -> list[Path]:
    _ensure_migrations_table(conn)
    applied = {row[0] for row in conn.execute("SELECT filename FROM schema_migrations")}
    all_migrations = sorted(MIGRATIONS_DIR.glob("*.sql"))
    return [m for m in all_migrations if m.name not in applied]


def apply_migrations(conn: psycopg.Connection) -> list[str]:
    """Apply every pending migration, each in its own transaction.

    Returns the filenames actually applied, in order. A migration file
    that fails leaves earlier ones committed and stops before any later
    one runs — never partially apply a single file's statements, since
    the whole file is one transaction.
    """
    applied_now = []
    for migration_path in pending_migrations(conn):
        sql = migration_path.read_text()
        with conn.transaction():
            conn.execute(sql)  # type: ignore[arg-type]
            conn.execute(
                "INSERT INTO schema_migrations (filename) VALUES (%s)",
                (migration_path.name,),
            )
        applied_now.append(migration_path.name)
    return applied_now


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is not set. Refusing to run.", file=sys.stderr)
        return 1

    with psycopg.connect(database_url) as conn:
        applied = apply_migrations(conn)

    if applied:
        print(f"Applied {len(applied)} migration(s): {', '.join(applied)}")
    else:
        print("No pending migrations.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
