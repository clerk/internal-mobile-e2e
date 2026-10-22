import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
}

interface ResolvedPackage {
  readonly directory: string;
  readonly manifest: PackageManifest;
}

function manifestAt(path: string): PackageManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as PackageManifest) : null;
  } catch {
    return null;
  }
}

function findPackage(packageDir: string, packageName: string): ResolvedPackage {
  const require = createRequire(join(resolve(packageDir), 'package.json'));
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const directory = join(searchPath, packageName);
    const manifest = manifestAt(join(directory, 'package.json'));
    if (manifest?.name === packageName) return { directory: realpathSync(directory), manifest };
  }
  throw new Error(`could not find ${packageName} from ${packageDir}`);
}

export function packageDirectoryFromModule(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));

  while (true) {
    const manifest = manifestAt(join(directory, 'package.json'));
    if (manifest?.name !== undefined) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`could not find a package.json above ${moduleUrl}`);
}

export function resolvePackageBinary(packageDir: string, packageName: string, binaryName: string): string {
  const resolved = findPackage(packageDir, packageName);
  const bin = resolved.manifest.bin;
  const relativePath =
    typeof bin === 'string'
      ? binaryName === packageName.split('/').at(-1)
        ? bin
        : undefined
      : typeof bin === 'object' && bin !== null && !Array.isArray(bin) && typeof (bin as Record<string, unknown>)[binaryName] === 'string'
        ? ((bin as Record<string, string>)[binaryName] as string)
        : undefined;
  if (relativePath === undefined) throw new Error(`${packageName} does not declare a ${binaryName} binary`);
  return resolve(resolved.directory, relativePath);
}

export function resolvePackageBinaryFromModule(moduleUrl: string, packageName: string, binaryName: string): string {
  return resolvePackageBinary(packageDirectoryFromModule(moduleUrl), packageName, binaryName);
}

export function installedPackageVersion(packageDir: string, packageName: string): string | undefined {
  try {
    const version = findPackage(packageDir, packageName).manifest.version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}
