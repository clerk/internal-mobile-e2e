import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const QUOTED_PATH = /(['"`])(\.{1,2}\/[^'"`\n]*)\1/g;

export function filesUnder(dir: string, skips: (name: string) => boolean = () => false): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return skips(entry.name) ? [] : filesUnder(path, skips);
    return entry.isFile() ? [path] : [];
  });
}

export const posix = (path: string): string => path.split(sep).join('/');

export function pathsThatLeaveTheTests(packageDir: string): readonly string[] {
  const specs = join(packageDir, 'specs');
  const config = join(packageDir, packageDir === PACKAGE_DIR ? 'specs/config.ts' : 'e2e.config.ts');
  const core = join(packageDir, 'src', 'core');
  const inside = (file: string): boolean => file === config || file === specs || file.startsWith(`${specs}${sep}`) || (packageDir === PACKAGE_DIR && file.startsWith(`${core}${sep}`));
  return [config, ...filesUnder(specs)].flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(QUOTED_PATH)]
      .map((match) => resolve(dirname(file), match[2]!))
      .filter((target) => !inside(target))
      .map((target) => `${posix(relative(packageDir, file))} names ${posix(relative(packageDir, target))}`),
  );
}
