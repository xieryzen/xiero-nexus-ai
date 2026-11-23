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

test("an upgrade from 1.10.0 keeps the servers, their log and the site accounts, and makes room for what an account hands over itself", () => {
  const work = mkdtempSync(join(tmpdir(), "xn-migrations-"));
  const sqlite = new Database(join(work, "nexus.db"));
  try {
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    // The database as 1.10.0 leaves it: two accounts, a machine with its log, a site account, a conversation table nothing ever wrote to.
    migrate(db, { migrationsFolder: migrationsUpTo(work, 16) });
    const user = sqlite.prepare("INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'hash', ?, 1795080000, 1795080000)");
    user.run("u-owner", "xieryzen", "owner@example.com", "owner");
    user.run("u-user", "haruto", "haruto@example.com", "user");
    sqlite
      .prepare(
        "INSERT INTO servers (id, name, host, port, username, auth_type, secret_ciphertext, host_key, access, status, created_by, created_at, updated_at) " +
          "VALUES ('s1', 'vps-1', '203.0.113.9', 22, 'root', 'password', 'v1:secret', 'ssh-ed25519 AAAA', 'admins', 'enabled', 'u-owner', 1795080000, 1795080000)",
      )
      .run();
    sqlite
      .prepare("INSERT INTO server_commands (id, server_id, server_name, kind, user_id, command, status, exit_code, output, created_at) VALUES ('c1', 's1', 'vps-1', 'command', 'u-owner', 'uptime', 'ok', 0, 'up 3 days', 1795080100)")
      .run();
    sqlite
      .prepare(
        "INSERT INTO site_accounts (id, name, site_url, username, secret_ciphertext, access, status, created_by, created_at, updated_at) " +
          "VALUES ('a1', 'shop', 'https://example.com/login', 'budi', 'v1:password', 'owners', 'enabled', 'u-owner', 1795080000, 1795080000)",
      )
      .run();
    const before = {
      servers: sqlite.prepare("SELECT id, name, host, port, username, auth_type, secret_ciphertext, host_key, access, status, created_by FROM servers").all(),
      commands: sqlite.prepare("SELECT id, server_id, server_name, kind, user_id, command, status, exit_code, output FROM server_commands").all(),
      accounts: sqlite.prepare("SELECT id, name, site_url, username, secret_ciphertext, access, status, created_by FROM site_accounts").all(),
    };

    migrate(db, { migrationsFolder: MIGRATIONS });

    // What was there is as it was: registered by an owner, and not handed over by anyone.
    assert.deepEqual(sqlite.prepare("SELECT id, name, host, port, username, auth_type, secret_ciphertext, host_key, access, status, created_by FROM servers").all(), before.servers);
    assert.deepEqual(sqlite.prepare("SELECT id, server_id, server_name, kind, user_id, command, status, exit_code, output FROM server_commands").all(), before.commands);
    assert.deepEqual(sqlite.prepare("SELECT id, name, site_url, username, secret_ciphertext, access, status, created_by FROM site_accounts").all(), before.accounts);
    assert.deepEqual(sqlite.prepare("SELECT owner_id FROM servers").all(), [{ owner_id: null }]);
    assert.deepEqual(sqlite.prepare("SELECT owner_id FROM site_accounts").all(), [{ owner_id: null }]);
    assert.deepEqual(sqlite.prepare("SELECT handed FROM server_commands").all(), [{ handed: 0 }]);

    // A name is one machine among the registered ones, and one among those of each account.
    const server = sqlite.prepare(
      "INSERT INTO servers (id, name, host, port, username, auth_type, secret_ciphertext, host_key, access, status, owner_id, created_at, updated_at) VALUES (?, ?, '203.0.113.9', 22, 'root', 'password', 'v1:x', 'ssh-ed25519 AAAA', 'owners', 'enabled', ?, 1795080000, 1795080000)",
    );
    server.run("s2", "vps-1", "u-user");
    server.run("s3", "vps-1", "u-owner");
    assert.throws(() => server.run("s4", "vps-1", null), /UNIQUE/);
    assert.throws(() => server.run("s5", "vps-1", "u-user"), /UNIQUE/);
    const account = sqlite.prepare(
      "INSERT INTO site_accounts (id, name, site_url, username, secret_ciphertext, access, status, owner_id, created_at, updated_at) VALUES (?, ?, 'https://example.com/login', 'budi', 'v1:x', 'owners', 'enabled', ?, 1795080000, 1795080000)",
    );
    account.run("a2", "shop", "u-user");
    assert.throws(() => account.run("a3", "shop", null), /UNIQUE/);
    assert.throws(() => account.run("a4", "shop", "u-user"), /UNIQUE/);

    // Conversations, their messages and the notes of an account are found by their words.
    sqlite.prepare("INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES ('chat1', 'u-user', 'Toko', 1795080000, 1795080000)").run();
    const message = sqlite.prepare("INSERT INTO chat_messages (chat_id, role, content, details, created_at) VALUES ('chat1', ?, ?, ?, 1795080000)");
    message.run("user", "Tokoku namanya Warung Kopi Senja", null);
    message.run("assistant", "Baik, saya catat.", '{"tools":[]}');
    sqlite.prepare("INSERT INTO account_memories (user_id, content, source, chat_id, created_at) VALUES ('u-user', 'Haruto runs the shop Warung Kopi Senja.', 'chat', 'chat1', 1795080000)").run();
    sqlite.prepare("INSERT INTO access_keys (id, owner_id, name, label, secret_ciphertext, created_at, updated_at) VALUES ('k1', 'u-user', 'api-key', 'API key', 'v1:x', 1795080000, 1795080000)").run();
    assert.throws(() => sqlite.prepare("INSERT INTO access_keys (id, owner_id, name, label, secret_ciphertext, created_at, updated_at) VALUES ('k2', 'u-user', 'api-key', 'API key', 'v1:x', 1795080000, 1795080000)").run(), /UNIQUE/);
    const found = (table: string, words: string) => sqlite.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(words).length;
    assert.equal(found("chat_messages_fts", "warung"), 1);
    assert.equal(found("account_memories_fts", "warung"), 1);
    sqlite.prepare("UPDATE chat_messages SET content = 'Tokoku namanya [kept by the app]' WHERE role = 'user'").run();
    assert.equal(found("chat_messages_fts", "warung"), 0);
    assert.equal(found("chat_messages_fts", "tokoku"), 1);

    // A conversation that is deleted takes its messages; the note it left stays, without it.
    sqlite.prepare("DELETE FROM chats WHERE id = 'chat1'").run();
    assert.equal(found("chat_messages_fts", "tokoku"), 0);
    assert.deepEqual(sqlite.prepare("SELECT chat_id FROM account_memories").all(), [{ chat_id: null }]);

    // An account that is deleted takes what it handed over and what is remembered about it; the registered machine and its log stay.
    sqlite.prepare("INSERT INTO server_commands (id, server_id, server_name, kind, user_id, command, status, handed, created_at) VALUES ('c2', 's2', 'vps-1', 'command', 'u-user', 'df -h', 'ok', 1, 1795080200)").run();
    sqlite.prepare("DELETE FROM users WHERE id = 'u-user'").run();
    assert.deepEqual(sqlite.prepare("SELECT id FROM servers ORDER BY id").all(), [{ id: "s1" }, { id: "s3" }]);
    assert.deepEqual(sqlite.prepare("SELECT id FROM site_accounts ORDER BY id").all(), [{ id: "a1" }]);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM access_keys").get() as { n: number }).n, 0);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM account_memories").get() as { n: number }).n, 0);
    assert.equal(found("account_memories_fts", "warung"), 0);
    // What was done on the machine stays written down, without the machine and the account.
    assert.deepEqual(sqlite.prepare("SELECT id, server_id, user_id, handed FROM server_commands ORDER BY id").all(), [
      { id: "c1", server_id: "s1", user_id: "u-owner", handed: 0 },
      { id: "c2", server_id: null, user_id: null, handed: 1 },
    ]);
    for (const table of ["chat_messages_fts", "account_memories_fts"]) {
      sqlite.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
    }
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    assert.equal(sqlite.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    sqlite.close();
    rmSync(work, { recursive: true, force: true });
  }
});
