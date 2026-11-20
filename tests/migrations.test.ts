import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** The migrations up to one of them, in a folder of their own: the database as an earlier version leaves it. */
function migrationsUpTo(work: string, last: number): string {
  const folder = join(work, `up-to-${last}`);
  cpSync(MIGRATIONS, folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
  return folder;
}

test("the migrations are applied in the order they were made", () => {
  const { entries } = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  assert.deepEqual(
    entries.map((entry) => entry.idx),
    entries.map((_, index) => index),
  );
  // A migration is applied when it is newer than the last one the database has: one that is not is never applied.
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i]!.when > entries[i - 1]!.when, `${entries[i]!.tag} is not newer than ${entries[i - 1]!.tag}`);
});

test("an upgrade from 1.8.0-rc.5 drops the sessions kept for site accounts, once, and nothing else of the accounts", () => {
  const work = mkdtempSync(join(tmpdir(), "xn-migrations-"));
  const sqlite = new Database(join(work, "nexus.db"));
  try {
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    // The database as 1.8.0-rc.5 leaves it: an account with a session that was kept, and one without.
    migrate(db, { migrationsFolder: migrationsUpTo(work, 13) });
    const add = sqlite.prepare(
      "INSERT INTO site_accounts (id, name, site_url, username, secret_ciphertext, session_ciphertext, session_saved_at, session_cookies, access, status, last_used_at, last_problem, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, 1795080000, 1795080000)",
    );
    add.run("a1", "shop", "https://example.com/login", "budi", "v1:password-of-budi", "v1:cookies-of-somebody", 1795080600, 3, "owners", 1795080600, null);
    add.run("a2", "shop-sari", "https://example.com/login", "sari", "v1:password-of-sari", null, null, 0, "admins", null, "The site did not take the sign-in.");
    const rows = () => sqlite.prepare("SELECT id, name, site_url, username, secret_ciphertext, session_ciphertext, session_saved_at, session_cookies, access, status, last_used_at, last_problem FROM site_accounts ORDER BY id").all();
    const before = rows() as Record<string, unknown>[];

    migrate(db, { migrationsFolder: MIGRATIONS });
    assert.deepEqual(rows(), [{ ...before[0], session_ciphertext: null, session_saved_at: null, session_cookies: 0 }, before[1]]);

    // A session that is kept after the upgrade stays: the next start drops nothing.
    sqlite.prepare("UPDATE site_accounts SET session_ciphertext = 'v1:cookies-of-budi', session_saved_at = 1795131000, session_cookies = 2 WHERE id = 'a1'").run();
    const kept = rows();
    migrate(db, { migrationsFolder: MIGRATIONS });
    assert.deepEqual(rows(), kept);
  } finally {
    sqlite.close();
    rmSync(work, { recursive: true, force: true });
  }
});
