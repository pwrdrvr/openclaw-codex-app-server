import { existsSync } from "node:fs";
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
  const resolver = params.resolver ?? ((specifier: string) => require.resolve(specifier));
  const pathExists = params.pathExists ?? existsSync;

  const promise = (async () => {
    try {
      return (await importer(params.specifier)) as T;
    } catch (error) {
      if (!isMissingPluginSdkSubpathError(error, params.specifier)) {
        throw error;
      }

      const openClawEntrypointPath = resolver("openclaw");
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
