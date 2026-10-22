import '../testing/git-env.ts';
import { filesUnder, PACKAGE_DIR, pathsThatLeaveTheTests, posix, QUOTED_PATH } from '../testing/seam.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';

describe('the tests are an e2e project of their own', () => {
  it('keeps test support imports inside the shared package', () => {
    assert.deepEqual(pathsThatLeaveTheTests(PACKAGE_DIR), []);
  });

  it('reads e2e.config.ts and every file under specs/, whatever its extension and however deep', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'verify-seam-'));
    const files: Readonly<Record<string, string>> = {
      'e2e.config.ts': "import { app } from './specs/app.ts';\nimport './src/core/keys.ts';\n",
      'specs/app.ts': "export { app } from './support/inputs.ts';\n",
      'specs/support/inputs.cts': "import keys = require('../../src/core/keys.ts');\n",
      'specs/features/sign-in/complete.e2e.tsx': "import '../../fixtures.ts';\nexport const load = (name: string) => import(`../../../testing/${name}.ts`);\n",
      'specs/features/sign-in/complete.settings.json': '{ "extends": "../../../src/core/instances/base.json" }\n',
      'src/core/keys.ts': "import '../../specs/support/inputs.cts';\n",
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(packageDir, file)), { recursive: true });
      writeFileSync(join(packageDir, file), text);
    }
    assert.deepEqual([...pathsThatLeaveTheTests(packageDir)].sort(), [
      'e2e.config.ts names src/core/keys.ts',
      'specs/features/sign-in/complete.e2e.tsx names testing/${name}.ts',
      'specs/features/sign-in/complete.settings.json names src/core/instances/base.json',
      'specs/support/inputs.cts names src/core/keys.ts',
    ]);
  });

  it('sees a relative path however a file names it: in an import, a re-export, a dynamic or commented import, a template, require under any name, import.meta.resolve, and a URL', () => {
    const lines = [
      "import { x } from '../src/core/x.ts';",
      "export type { X } from '../../src/core/types.ts';",
      'export * from "../src/core/types.ts";',
      "await import('../src/host.ts');",
      "await import(/* webpackIgnore: true */ '../src/host.ts');",
      'await import(`../src/core/${name}.ts`);',
      "import '../testing/git-env.ts';",
      "require('../src/core/launch.mjs');",
      "requireOnlyForAnAgent('../src/core/agent.ts');",
      "createRequire(import.meta.url)('../src/core/agent.ts');",
      "import.meta.resolve('../src/core/keys.ts');",
      "new URL('../bin/control', import.meta.url);",
      '{ "extends": "../src/core/instances/base.json" }',
    ];
    for (const line of lines) assert.equal([...line.matchAll(QUOTED_PATH)].length, 1, line);
    assert.equal([..."import { test } from '@e2e-dev/mobile'; import { join } from 'node:path'; join(here, '..', '..');".matchAll(QUOTED_PATH)].length, 0, 'a package and a path segment are not relative paths');
  });
});

const KEY_PREFIXES = ['sk_test_', 'sk_live_', 'rk_test_', 'rk_live_'];
const SCANNED_KEY = new RegExp(`(?<![A-Za-z0-9])(?:${KEY_PREFIXES.join('|')})(?:[A-Za-z0-9]{24}|[A-Za-z0-9]{40,})(?![A-Za-z0-9])`);

describe('made-up keys in this package', () => {
  it('never have a length that a secret scanner takes for a real key: exactly 24 letters and digits after the prefix, which GitHub refuses to take in a push, or 40 and more', () => {
    const held = filesUnder(PACKAGE_DIR, (name) => name === 'node_modules' || name === 'dist' || name.startsWith('.'))
      .filter((file) => SCANNED_KEY.test(readFileSync(file, 'utf8')))
      .map((file) => posix(relative(PACKAGE_DIR, file)));
    assert.deepEqual(held, [], 'give the made-up key in each of these files another length');
  });

  it('are told from scanned ones by their length alone', () => {
    for (const prefix of KEY_PREFIXES) {
      for (const length of [24, 40, 42, 99]) assert.equal(SCANNED_KEY.test(`const key = '${prefix}${'a1B2'.repeat(25).slice(0, length)}';`), true, `${prefix} and ${length}`);
      for (const length of [12, 23, 25, 32, 39]) assert.equal(SCANNED_KEY.test(`const key = '${prefix}${'a1B2'.repeat(25).slice(0, length)}';`), false, `${prefix} and ${length}`);
    }
    assert.equal(SCANNED_KEY.test(`pk_test_${'a'.repeat(24)}`), false, 'a publishable key is public');
  });
});
