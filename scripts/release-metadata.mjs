import { appendFileSync } from "node:fs";
import { parseReleaseTag } from "./release-tag.mjs";

const metadata = parseReleaseTag(process.argv[2]);

if (process.env.GITHUB_OUTPUT) {
  appendGitHubOutput("version", metadata.version);
  appendGitHubOutput("is_prerelease", String(metadata.isPrerelease));
  appendGitHubOutput("release_channel", metadata.channel ?? "stable");
  appendGitHubOutput("npm_dist_tag", metadata.npmDistTag);
}

process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);

function appendGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
