#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runCli } from "./cli-command.js";
import { configureHouseRules } from "./house-rules.js";

async function loadHouseRules(args: string[]) {
  const index = args.indexOf("--house-rules");
  const explicit = index === -1 ? undefined : args[index + 1];

  if (index !== -1) {
    args.splice(index, 2);
  }

  const target = resolve(explicit ?? "house-rules/index.mjs");

  if (!existsSync(target)) {
    if (explicit) throw new Error(`House rules not found: ${explicit}`);
    return;
  }

  const module = await import(pathToFileURL(target).href);
  configureHouseRules(module.default ?? module.houseRules);
}

const args = process.argv.slice(2);

try {
  await loadHouseRules(args);
  process.exitCode = runCli(args);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
}
