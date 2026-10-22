import '../testing/git-env.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { coreVersion } from '../src/core/version.ts';

const root = join(import.meta.dirname, '..');

it('loads every built export and ships its declaration without TypeScript stripping', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    exports: Record<string, { types: string; import: string }>;
  };
  const subpaths = Object.entries(pkg.exports).flatMap(([key, target]) => {
    if (!key.endsWith('/*')) return [{ key, types: target.types }];
    const dir = target.import.slice(0, -'*.js'.length);
    return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.js'))
      .map((file) => ({ key: `${key.slice(0, -1)}${file.slice(0, -'.js'.length)}`, types: `${dir}${file.slice(0, -'.js'.length)}.d.ts` }))
      .filter(({ key: subpath }) => !(subpath in pkg.exports));
  });
  assert.ok(subpaths.length > 50, `found ${subpaths.length} subpaths`);
  for (const { key, types } of subpaths) {
    assert.ok(existsSync(join(root, types)), types);
    await import(`${pkg.name}${key === '.' ? '' : key.slice(1)}`);
  }
  const built = await import('@clerk/internal-mobile-e2e/core/version');
  assert.equal(built.coreVersion(), coreVersion());
});

it('executes the built remote recipe beside the session agent', () => {
  const output = execFileSync(process.execPath, [
    join(root, 'dist/src/core/remote/recipe.js'),
    JSON.stringify({ device: { platform: 'ios', id: 'UDID-1', name: 'Test Phone' }, request: { op: 'inputs' } }),
  ], {
    env: { ...process.env, VERIFY_SESSION_DEVICE_MODULE: join(root, 'testing/fake-session-device.ts') },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), ['app.txt', 'extra.txt', 'Sources']);
});
