import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

let loaded = false;

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;

  let directory = resolve(process.cwd());
  let envPath = resolve(directory, ".env");
  while (!existsSync(envPath)) {
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
    envPath = resolve(directory, ".env");
  }

  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
