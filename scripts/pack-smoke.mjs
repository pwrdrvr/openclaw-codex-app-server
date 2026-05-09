import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  execPackageManager(["pack", "--pack-destination", tarballDir]);

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

  execPackageManager(["add", "--lockfile=false", tarballs[0]], installDir);

  const packageDir = path.join(installDir, "node_modules", "openclaw-codex-app-server");
  const expectedFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    "openclaw.plugin.json",
    path.join("dist", "index.js"),
    path.join("dist", "index.d.ts"),
    path.join("dist", "src", "client.js"),
    path.join("dist", "src", "client.d.ts"),
  ];
  const unexpectedFiles = [
    "AGENTS.md",
    "OVERNIGHT-TODO.md",
    "index.ts",
    path.join("src", "client.ts"),
    path.join("src", "client.test.ts"),
    path.join("src", "controller.test.ts"),
    "tsconfig.json",
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

  const installedPackageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const extensions = installedPackageJson.openclaw?.extensions;
  if (!Array.isArray(extensions) || extensions[0] !== "./dist/index.js") {
    throw new Error(
      `Expected openclaw.extensions[0] to be ./dist/index.js, got ${JSON.stringify(extensions)}`,
    );
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

function execPackageManager(args, cwd = workspaceRoot) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    exec(process.execPath, [npmExecPath, ...args], cwd);
    return;
  }
  exec("corepack", ["pnpm", ...args], cwd);
}
