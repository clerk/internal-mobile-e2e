import '../testing/git-env.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { installedPackageVersion, packageDirectoryFromModule, resolvePackageBinary } from '../src/core/tools.ts';

describe('package tools', () => {
  it('resolves a package-owned binary from bin metadata through nested node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-package-tools-'));
    try {
      const packageDir = join(root, 'node_modules', '@clerk', 'internal-mobile-e2e');
      const installed = join(packageDir, 'node_modules', 'agent-device');
      const conflicting = join(root, 'node_modules', 'agent-device');
      const packageEntry = (directory: string, version: string) => {
        mkdirSync(join(directory, 'bin'), { recursive: true });
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'agent-device', version, exports: { './client': './index.js' }, bin: { 'agent-device': 'bin/agent-device.js' } }));
        writeFileSync(join(directory, 'index.js'), '');
        writeFileSync(join(directory, 'bin', 'agent-device.js'), '');
      };
      mkdirSync(join(packageDir, 'dist', 'src', 'core'), { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@clerk/internal-mobile-e2e', dependencies: { 'agent-device': '2.0.0' } }));
      writeFileSync(join(packageDir, 'dist', 'src', 'core', 'tools.js'), '');
      packageEntry(installed, '2.0.0');
      packageEntry(conflicting, '1.0.0');

      const moduleUrl = pathToFileURL(join(packageDir, 'dist', 'src', 'core', 'tools.js')).href;
      const ownedPackageDir = packageDirectoryFromModule(moduleUrl);

      assert.equal(ownedPackageDir, packageDir);
      assert.equal(installedPackageVersion(ownedPackageDir, 'agent-device'), '2.0.0');
      assert.equal(resolvePackageBinary(ownedPackageDir, 'agent-device', 'agent-device'), realpathSync(resolve(installed, 'bin', 'agent-device.js')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
