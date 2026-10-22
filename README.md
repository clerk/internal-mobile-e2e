Internal. Do not use.

Internal e2e tooling for Clerk's SDK repos. No stability guarantees and no support.

The shared core provides the CLI, device leases, throwaway Clerk instances, a Backend API stand-in, redaction, evidence, and test support. It builds on tester.army's `e2e` and agent-device.

Used by clerk-ios, clerk-android, and clerk/javascript in `integration/expo-native/`. Each SDK repo keeps its `bin`, `host`, platform code, `specs/app.ts`, and tests in `specs/features/`.

Install from a pinned git commit. This package is not on npm. Its `prepare` script builds the ESM modules and declarations during installation.

```json
{
  "dependencies": {
    "@clerk/internal-mobile-e2e": "github:clerk/internal-mobile-e2e#<commit>"
  }
}
```

Add this to the consumer's `.npmrc`.

```ini
allow-git=all
```

npm 12 blocks git dependencies by default. `allow-git=root` is insufficient because the package builds on install, which requires fetching it as a non-root dependency.

A consumer's `bin/control-clerk-ios` calls the shared CLI with its host and package directory.

```js
#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { ensureRuntime } from '@clerk/internal-mobile-e2e/core/launch';

await ensureRuntime();
const { main } = await import('@clerk/internal-mobile-e2e');
const { host } = await import('../src/host.ts');
const packageDir = fileURLToPath(new URL('../', import.meta.url));
process.exitCode = await main(process.argv.slice(2), host, { packageDir });
```

The shared `specs/config` export takes the consumer's app. Use it in `e2e.config.ts`.

```ts
import { defineConfig } from '@clerk/internal-mobile-e2e/specs/config';
import { app } from './specs/app.ts';

export default defineConfig({ app });
```

Keep a small `specs/fixtures.ts` in the consumer so its feature tests can import their configured test.

```ts
import { createTest } from '@clerk/internal-mobile-e2e/specs/fixtures';
import { app } from './app.ts';

export const { test, expect, CLERK_TEST_CODE } = createTest(app);
```

To change the core, open a PR here and point an SDK repo's PR at the unmerged commit to try it. Merge here, then bump the commit pin in each SDK repo.

For local development, use Node 24.8 or later within Node 24.

```sh
npm install
npm run build
npm test
npm run typecheck
```

The build generates a source fingerprint in `src/core/version.json` and copies it into `dist`. Remote sessions use it to reject incompatible cores. Runtime assets, including the compiled remote recipe, ship inside `dist`. Neither generated output nor dependencies are committed.

This tooling creates and deletes throwaway Clerk instances and reads the `MOBILE_VERIFICATION_PLATFORM_API_KEY` secret at runtime through the consumer's `CLERK_PLATFORM_API_KEY` environment variable. No secrets live in this repo.
