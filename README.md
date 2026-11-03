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

## Changing instance settings in a test

Every run starts on the settings in `src/core/instances/base.json`. To change instance settings for one test, call `host.useSettings` with the Platform API config leaves to change. Name each leaf by its full dotted path.

```ts
test('asks for MFA during sign-up', async ({ host }) => {
  await host.useSettings({
    config: { 'auth_multi_factor.required_for_sign_up': true },
    environment: { 'user_settings.sign_up.mfa.required': true },
  });
  await host.launch();
});
```

The CLI reads the current value of each leaf, makes the change, and waits until the instance's public `/v1/environment` shows it. The `environment` field is optional. With it, the CLI waits for exactly those leaves, and the call fails if they do not show the change within 15 seconds. Without it, the CLI waits for any leaf of the environment to change and records the leaves that did.

To turn a setting off, pass its off value.

Clerk's servers apply a change at once, so a session task that the change requires appears without a relaunch. The SDK's screens can still show the settings that the app read when it launched. On Android, the setup-MFA task kept offering an authenticator app that a test turned off after launch, until the app launched again. iOS showed the change at once. Call `host.launch()` after `host.useSettings`, as in the example above, unless the test is about an app that is already running.

When the test ends, pass or fail, the CLI puts each leaf back to the value it read before the change. If the test process stops before it restores them, the CLI restores them after e2e exits. If the CLI stops too, the next `run` or `up` restores them before it does anything else. `run.json` lists each change under `settings`, and `attach` refuses a run that left a change unrestored.

To find the name and current value of a leaf, run the `settings` verb with a prefix:

```sh
bin/control-clerk-ios settings auth_multi_factor
```

Each line it prints, such as `"auth_multi_factor.required_for_sign_up": false,`, pastes into `config`. The verb reads the application this worktree holds and needs no device.

## Changing the core

To change the core, open a PR here and point an SDK repo's PR at the unmerged commit to try it. Merge here, then bump the commit pin in each SDK repo.

For local development, use Node 24.8 or later within Node 24.

```sh
npm install
npm run build
npm test
npm run typecheck
```

The build generates a source fingerprint in `src/core/version.json` and copies it into `dist`. Remote sessions use it to reject incompatible cores. Runtime assets, including the compiled remote recipe, ship inside `dist`. Neither generated output nor dependencies are committed.

This tooling creates and deletes throwaway Clerk instances and reads the key at runtime from the `MOBILE_VERIFICATION_PLATFORM_API_KEY` environment variable, which each consumer's CI fills from the secret of the same name. No secrets live in this repo.
