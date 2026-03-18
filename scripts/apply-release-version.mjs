import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseTag } from "./release-tag.mjs";

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = parseReleaseTag(process.argv[2]).version;

const packageJsonPath = path.join(workspaceRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
process.stdout.write(`updated package.json -> ${version}\n`);

const clientPath = path.join(workspaceRoot, "src/client.ts");
const clientSource = readFileSync(clientPath, "utf8");
const updatedClientSource = clientSource.replace(
  /clientInfo: \{ name: "openclaw-codex-app-server", version: "[^"]+" \}/,
  `clientInfo: { name: "openclaw-codex-app-server", version: "${version}" }`,
);
if (updatedClientSource === clientSource) {
  throw new Error("Could not update clientInfo version in src/client.ts");
}
writeFileSync(clientPath, updatedClientSource);
process.stdout.write(`updated src/client.ts -> ${version}\n`);
