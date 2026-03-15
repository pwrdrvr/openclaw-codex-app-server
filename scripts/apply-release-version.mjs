import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = parseReleaseVersion(process.argv[2]);

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

function parseReleaseVersion(tagName) {
  if (!tagName) {
    throw new Error("Missing release tag. Expected vX.Y.Z");
  }
  const match = tagName.trim().match(/^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (!match) {
    throw new Error(`Invalid release tag: ${tagName}. Expected vX.Y.Z`);
  }
  return match[1];
}
