import "dotenv/config";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { getDb } from "./queries/connection";

const migrationsFolder = fileURLToPath(
  new URL("../db/migrations", import.meta.url)
);

await migrate(getDb(), { migrationsFolder });
console.log("Database migrations are up to date.");
