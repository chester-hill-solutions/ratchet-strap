import { readFileSync } from "node:fs";
import { record } from "./validation.js";

const manifest = record(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")), "RatchetStrap package.json");
if (typeof manifest.version !== "string") throw new Error("RatchetStrap package version is missing");
export const packageName = "@chester-hill-solutions/ratchet-strap";
export const packageVersion = manifest.version;
