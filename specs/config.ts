import type { E2EConfig } from 'e2e';
import { composeE2EConfig } from './support/config.ts';
import { readTarget, type TestApp } from './support/inputs.ts';

export function defineConfig({ app }: { readonly app: TestApp }): E2EConfig {
  const env = process.env;
  return composeE2EConfig(app, readTarget(app, env), env);
}
