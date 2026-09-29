import "dotenv/config";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { resolveMigrationsFolder } from "./lib/migration-path";
import { getDb } from "./queries/connection";

const migrationsFolder = resolveMigrationsFolder(process.cwd());

await migrate(getDb(), { migrationsFolder });
console.log("Database migrations are up to date.");
await getDb().$client.end();
