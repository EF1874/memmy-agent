import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface WindowsStorePathOptions {
  isWindowsStore: boolean;
  resourcesPath: string;
  localAppDataPath: string | undefined;
}

export function resolveWindowsStoreUserDataPath(options: WindowsStorePathOptions): string | null {
  const identity = resolveWindowsStoreIdentity(options);
  if (!identity) {
    return null;
  }
  if (!options.localAppDataPath) {
    throw new Error("LOCALAPPDATA is unavailable for the Windows Store package");
  }

  return join(
    options.localAppDataPath,
    "Packages",
    `${identity.identityName}_${identity.publisherId}`,
    "LocalState",
    "Memmy"
  );
}

export function resolveWindowsStoreAumid(options: WindowsStorePathOptions): string | null {
  const identity = resolveWindowsStoreIdentity(options);
  return identity
    ? `${identity.identityName}_${identity.publisherId}!${identity.applicationId}`
    : null;
}

function resolveWindowsStoreIdentity(options: WindowsStorePathOptions): {
  identityName: string;
  publisherId: string;
  applicationId: string;
} | null {
  if (!options.isWindowsStore) {
    return null;
  }

  const packageRoot = findPackageRoot(options.resourcesPath);
  const manifest = readFileSync(join(packageRoot, "AppxManifest.xml"), "utf8");
  const identityName = /<Identity\b[^>]*\bName=["']([^"']+)["']/i.exec(manifest)?.[1];
  if (!identityName) {
    throw new Error("Windows Store AppxManifest.xml is missing Identity Name");
  }
  const applicationId = /<Application\b[^>]*\bId=["']([^"']+)["']/i.exec(manifest)?.[1];
  if (!applicationId) {
    throw new Error("Windows Store AppxManifest.xml is missing Application Id");
  }

  const publisherId = basename(packageRoot).split("_").at(-1);
  if (!publisherId || publisherId === basename(packageRoot)) {
    throw new Error("Windows Store package full name is missing its publisher ID");
  }

  return { identityName, publisherId, applicationId };
}

function findPackageRoot(resourcesPath: string): string {
  let candidate = resolve(resourcesPath);
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(candidate, "AppxManifest.xml"))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  throw new Error(`Cannot find AppxManifest.xml above ${resourcesPath}`);
}
