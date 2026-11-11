/**
 * Standalone migration runner: `npm run db:migrate`.
 * Also runs automatically at app boot (see db/index.ts); this script is for
 * explicit/CI use. Independent of the server-only runtime module.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const path = process.env.DATABASE_PATH ?? "./data/nexus.db";
const dir = dirname(path);
if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });

const sqlite = new Database(path);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);
migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
// eslint-disable-next-line no-console
console.log(`[xiero-nexus] migrations applied to ${path}`);
sqlite.close();
