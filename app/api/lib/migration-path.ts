import { resolve } from "node:path";

export function resolveMigrationsFolder(workingDirectory: string): string {
  return resolve(workingDirectory, "db/migrations");
}
