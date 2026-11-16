import "server-only";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, asc, eq } from "drizzle-orm";
import { env } from "@/lib/env";
import { hashPassword } from "@/lib/crypto";
import * as schema from "./schema";

type DB = BetterSQLite3Database<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __nexusDb: DB | undefined;
}

function create(): DB {
  // Fail on the first request, with a clear log line, instead of much later
  // when a provider key or 2FA secret has to be encrypted.
  if (env.isProd) void env.encryptionKey;

  const path = env.databasePath;
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });

  const migrationsFolder = join(process.cwd(), "drizzle");
  if (existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[xiero-nexus] migrations folder not found — run `npm run db:generate`.",
    );
  }

  ensureBootstrapAdmin(db);
  ensureOwner(db);
  return db;
}

function ensureBootstrapAdmin(db: DB) {
  const admin = env.bootstrapAdmin();
  if (!admin) return;
  const existing = db.select({ id: schema.users.id }).from(schema.users).all();
  if (existing.length > 0) return;
  db.insert(schema.users)
    .values({
      username: admin.username,
      email: admin.email,
      passwordHash: hashPassword(admin.password),
      role: "owner",
      status: "active",
    })
    .run();
  // eslint-disable-next-line no-console
  console.log(
    `[xiero-nexus] bootstrap admin created: ${admin.username} <${admin.email}>`,
  );
}

/**
 * An installation has an owner: the one who manages its accounts. One from
 * before there were owners has none, and then its first administrator is the
 * owner: the account that set it up. Done when the database is opened, so an
 * upgrade needs no step by hand.
 */
function ensureOwner(db: DB) {
  const owner = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "owner")).get();
  if (owner) return;
  const first = db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users)
    .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")))
    .orderBy(asc(schema.users.createdAt), asc(schema.users.id))
    .get();
  if (!first) return;
  db.update(schema.users).set({ role: "owner", updatedAt: new Date() }).where(eq(schema.users.id, first.id)).run();
  db.insert(schema.auditLogs)
    .values({
      actorUserId: null,
      action: "system.owner.assigned",
      targetType: "user",
      targetId: first.id,
      metadata: JSON.stringify({ username: first.username, reason: "there was no owner; the first administrator is the owner" }),
    })
    .run();
  // eslint-disable-next-line no-console
  console.log(`[xiero-nexus] there was no owner: ${first.username}, the first administrator, is the owner now`);
}

function getDb(): DB {
  // One connection per process, also when this module is loaded in more than
  // one server bundle (the request handlers and the background worker).
  if (globalThis.__nexusDb) return globalThis.__nexusDb;
  const instance = create();
  globalThis.__nexusDb = instance;
  // The background worker normally starts with the server (instrumentation.ts).
  // Starting it here as well covers a host where that hook does not run; a
  // second start does nothing.
  void import("@/lib/worker")
    .then((worker) => worker.ensureWorker())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[xiero-nexus] could not start the background worker:", err);
    });
  return instance;
}

/**
 * Open the database now: apply the migrations and start the background
 * worker. Called when the server starts (src/instrumentation.ts), so that
 * queued work goes on before the first request arrives.
 */
export function openDatabase(): void {
  getDb();
}

/**
 * Lazy proxy: the SQLite connection, migrations, and bootstrap run on FIRST
 * use (a real request), never at module import — so `next build` does not
 * touch the database.
 */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
