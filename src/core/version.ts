import { readFileSync } from 'node:fs';

export function coreVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL('./version.json', import.meta.url), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error('src/core/version.json must contain a string version');
  }
  return parsed.version;
}
