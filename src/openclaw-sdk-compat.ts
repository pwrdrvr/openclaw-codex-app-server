import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export type PluginSdkCompatLogger = {
  debug?: (message: string) => void;
};

type CompatImporter = (specifier: string) => Promise<unknown>;
type CompatResolver = (specifier: string) => string;
type CompatPathExists = (targetPath: string) => boolean;
type CompatReadFile = (targetPath: string) => string;

const compatModuleCache = new Map<string, Promise<unknown>>();

export function isMissingPluginSdkSubpathError(error: unknown, specifier: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  const message = error.message ?? "";
  if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    return true;
  }
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  return (
    message.includes("Cannot find module") ||
    message.includes("Cannot find package") ||
    message.includes('is not defined by "exports"') ||
    message.includes(specifier) ||
    message.includes("/plugin-sdk/root-alias.cjs/")
  );
}

export function resolveCompatFallbackPath(
  openClawEntrypointPath: string,
  fallbackRelativePath: string,
): string {
  return path.resolve(path.dirname(openClawEntrypointPath), "..", fallbackRelativePath);
}

function readPackageJsonNameAndExports(
  packageRoot: string,
  readFile: CompatReadFile,
): { name?: string; exports?: Record<string, unknown>; bin?: string | Record<string, unknown> } | null {
  try {
    return JSON.parse(readFile(path.join(packageRoot, "package.json"))) as {
      name?: string;
      exports?: Record<string, unknown>;
      bin?: string | Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

function isTrustedOpenClawRoot(
  packageRoot: string,
  pathExists: CompatPathExists,
  readFile: CompatReadFile,
): boolean {
  const pkg = readPackageJsonNameAndExports(packageRoot, readFile);
  if (!pkg || pkg.name !== "openclaw") {
    return false;
  }
  const exports = pkg.exports ?? {};
  if (!Object.prototype.hasOwnProperty.call(exports, "./plugin-sdk")) {
    return false;
  }
  const hasCliEntry = Object.prototype.hasOwnProperty.call(exports, "./cli-entry");
  const hasOpenClawBin =
    (typeof pkg.bin === "string" && pkg.bin.toLowerCase().includes("openclaw")) ||
    (typeof pkg.bin === "object" &&
      pkg.bin !== null &&
      typeof pkg.bin.openclaw === "string");
  return hasCliEntry || hasOpenClawBin || pathExists(path.join(packageRoot, "openclaw.mjs"));
}

function resolveTrustedOpenClawRootFromStart(
  startPath: string | undefined,
  pathExists: CompatPathExists,
  readFile: CompatReadFile,
): string | null {
  if (!startPath) {
    return null;
  }
  let cursor = path.resolve(startPath);
  if (!path.extname(cursor)) {
    // Keep directory-like hints as-is.
  } else {
    cursor = path.dirname(cursor);
  }
  for (let depth = 0; depth < 12; depth += 1) {
    if (isTrustedOpenClawRoot(cursor, pathExists, readFile)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

export function resolveOpenClawEntrypointPath(params?: {
  resolver?: CompatResolver;
  pathExists?: CompatPathExists;
  readFile?: CompatReadFile;
  argv1?: string;
  cwd?: string;
}): string {
  const resolver = params?.resolver ?? ((specifier: string) => require.resolve(specifier));
  const pathExists = params?.pathExists ?? existsSync;
  const readFile = params?.readFile ?? ((targetPath: string) => readFileSync(targetPath, "utf-8"));
  const hostRoot =
    resolveTrustedOpenClawRootFromStart(params?.argv1 ?? process.argv[1], pathExists, readFile) ??
    resolveTrustedOpenClawRootFromStart(params?.cwd ?? process.cwd(), pathExists, readFile);
  if (hostRoot) {
    const distEntrypoint = path.join(hostRoot, "dist", "index.js");
    if (pathExists(distEntrypoint)) {
      return distEntrypoint;
    }
    return path.join(hostRoot, "src", "index.ts");
  }
  return resolver("openclaw");
}

export async function loadOpenClawCompatModule<T>(params: {
  specifier: string;
  fallbackRelativePath: string;
  label: string;
  logger?: PluginSdkCompatLogger;
  importer?: CompatImporter;
  resolver?: CompatResolver;
  pathExists?: CompatPathExists;
  cache?: Map<string, Promise<unknown>>;
}): Promise<T> {
  const cache = params.cache ?? compatModuleCache;
  const cacheKey = `${params.specifier}::${params.fallbackRelativePath}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return (await cached) as T;
  }

  const importer = params.importer ?? (async (specifier: string) => await import(specifier));
  const pathExists = params.pathExists ?? existsSync;

  const promise = (async () => {
    try {
      return (await importer(params.specifier)) as T;
    } catch (error) {
      if (!isMissingPluginSdkSubpathError(error, params.specifier)) {
        throw error;
      }

      const openClawEntrypointPath = resolveOpenClawEntrypointPath({
        resolver: params.resolver,
        pathExists,
      });
      const fallbackPath = resolveCompatFallbackPath(
        openClawEntrypointPath,
        params.fallbackRelativePath,
      );
      if (!pathExists(fallbackPath)) {
        throw error;
      }
      params.logger?.debug?.(`codex ${params.label} sdk fallback using ${fallbackPath}`);
      return (await importer(pathToFileURL(fallbackPath).href)) as T;
    }
  })();

  cache.set(cacheKey, promise);
  try {
    return (await promise) as T;
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
}
