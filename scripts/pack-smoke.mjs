import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-pack-smoke-"));
const tarballDir = path.join(tempRoot, "tarballs");
const installDir = path.join(tempRoot, "install");

mkdirSync(tarballDir, { recursive: true });
mkdirSync(installDir, { recursive: true });

try {
  exec("pnpm", ["pack", "--pack-destination", tarballDir]);

  const tarballs = readdirSync(tarballDir)
    .filter((entry) => entry.endsWith(".tgz"))
    .sort()
    .map((entry) => path.join(tarballDir, entry));

  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one tarball, found ${tarballs.length}`);
  }

  writeFileSync(
    path.join(installDir, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw-codex-app-server-pack-smoke",
        private: true,
        version: "0.0.0",
        packageManager: "npm@10.9.2",
      },
      null,
      2,
    )}\n`,
  );

  exec("npm", ["install", "--no-package-lock", tarballs[0]], installDir);

  const packageDir = path.join(installDir, "node_modules", "openclaw-codex-app-server");
  const expectedFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    "index.ts",
    "openclaw.plugin.json",
    path.join("src", "client.ts"),
  ];
  const unexpectedFiles = [
    "AGENTS.md",
    "OVERNIGHT-TODO.md",
    path.join("src", "client.test.ts"),
    path.join("src", "controller.test.ts"),
  ];

  for (const relativePath of expectedFiles) {
    if (!existsSync(path.join(packageDir, relativePath))) {
      throw new Error(`Missing expected published file: ${relativePath}`);
    }
  }

  for (const relativePath of unexpectedFiles) {
    if (existsSync(path.join(packageDir, relativePath))) {
      throw new Error(`Found unexpected published file: ${relativePath}`);
    }
  }

  process.stdout.write(`pack smoke ok (${tempRoot})\n`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function exec(command, args, cwd = workspaceRoot) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}
