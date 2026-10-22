import '../testing/git-env.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { agentCheck, agentEnvironment, takeAgent } from '../src/core/agent.ts';
import { BACKUP_AGENT_MODEL, DEFAULT_AGENT_MODEL, UnusableAgentKey, readAgent } from '../specs/support/agent.ts';
import { composeE2EConfig } from '../specs/support/config.ts';
import { IOS_APP, SAMPLE_INPUTS } from '../testing/sample-inputs.ts';

const GATEWAY_KEY = `gw_${'k'.repeat(20)}UnitTestOnly${'z'.repeat(20)}`;
const TARGET = SAMPLE_INPUTS.target;

function keyFile(mode: number, text = `${GATEWAY_KEY}\n`): string {
  const file = join(mkdtempSync(join(tmpdir(), 'verify-agent-key-')), 'ai-gateway-key');
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
  return file;
}

function modelOf(config: ReturnType<typeof composeE2EConfig>): { readonly provider: string; readonly modelId: string } {
  return config.agents?.default?.model as unknown as { readonly provider: string; readonly modelId: string };
}

describe('no agent without a gateway key', () => {
  it('composes a config with no agent', () => {
    const config = composeE2EConfig(IOS_APP, TARGET, {});
    assert.deepEqual(Object.keys(config).sort(), ['assertionTimeout', 'targets', 'tests', 'timeout', 'trace', 'workers']);
    assert.equal(config.agents, undefined);
    assert.equal(composeE2EConfig(IOS_APP, TARGET, { AI_GATEWAY_API_KEY: '  ' }).agents, undefined, 'a blank key is no key');
  });

  it('does not need ai unless a gateway key enables an agent', () => {
    const script = [
      "import { registerHooks } from 'node:module';",
      "registerHooks({ resolve: (specifier, context, next) => { if (specifier === 'ai') throw new Error('ai is not installed'); return next(specifier, context); } });",
      `const { composeE2EConfig } = await import(${JSON.stringify(fileURLToPath(new URL('../specs/support/config.ts', import.meta.url)))});`,
      `const target = ${JSON.stringify(TARGET)};`,
      "const app = { platforms: ['ios'], id: () => 'com.clerk.sample', entry: () => ({ kind: 'binary' }) };",
      "console.log(Object.keys(composeE2EConfig(app, target, {})).sort().join(','));",
      "try { composeE2EConfig(app, target, { AI_GATEWAY_API_KEY: 'x'.repeat(24) }); console.log('composed an agent'); } catch (error) { console.log(error.message); }",
    ].join('\n');
    const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(printed, ['assertionTimeout,targets,tests,timeout,trace,workers', 'ai is not installed']);
  });

  it('tells doctor that no agent is configured, as a passing check', () => {
    assert.equal(takeAgent({})(), null);
    assert.deepEqual(agentCheck(takeAgent({})), {
      id: 'agent',
      ok: true,
      detail: 'none: AI_GATEWAY_API_KEY and AI_GATEWAY_API_KEY_FILE are not set, so agent.act and agent.assert have no model',
    });
  });
});

describe('the agent with a gateway key', () => {
  it('is the default model on the Vercel AI Gateway, with the replay cache off', () => {
    assert.equal(DEFAULT_AGENT_MODEL, 'anthropic/claude-haiku-5.5');
    const config = composeE2EConfig(IOS_APP, TARGET, { AI_GATEWAY_API_KEY: GATEWAY_KEY });
    assert.deepEqual(Object.keys(config.agents ?? {}), ['default']);
    assert.deepEqual({ provider: modelOf(config).provider, modelId: modelOf(config).modelId }, { provider: 'gateway', modelId: 'anthropic/claude-haiku-5.5' });
    assert.equal(config.cache, 'off', 'every agent step is judged by the model on the screen of this run');
  });

  it('names one backup model that the gateway tries when the default model fails', () => {
    assert.equal(BACKUP_AGENT_MODEL, 'openai/gpt-6-luna-fast');
    const config = composeE2EConfig(IOS_APP, TARGET, { AI_GATEWAY_API_KEY: GATEWAY_KEY });
    assert.deepEqual(config.agents?.default?.providerOptions, { gateway: { models: ['openai/gpt-6-luna-fast'] } });
    assert.equal(readAgent({ AI_GATEWAY_API_KEY: GATEWAY_KEY })?.backup, 'openai/gpt-6-luna-fast');
  });

  it('reads the key from a file that only the user can read', () => {
    const file = keyFile(0o600);
    assert.equal(modelOf(composeE2EConfig(IOS_APP, TARGET, { AI_GATEWAY_API_KEY_FILE: file })).modelId, 'anthropic/claude-haiku-5.5');
    assert.equal(readAgent({ AI_GATEWAY_API_KEY_FILE: file })?.credential.variable, 'AI_GATEWAY_API_KEY_FILE');
    assert.equal(readAgent({ AI_GATEWAY_API_KEY: GATEWAY_KEY, AI_GATEWAY_API_KEY_FILE: file })?.credential.variable, 'AI_GATEWAY_API_KEY', 'the inline key wins, as it does for the Platform API key');
  });

  it('hands e2e the absolute path of a key file named relative to the caller', () => {
    const file = keyFile(0o600);
    const named = relative(process.cwd(), file);
    assert.equal(isAbsolute(named), false);
    assert.deepEqual(agentEnvironment(readAgent({ AI_GATEWAY_API_KEY_FILE: named })), { AI_GATEWAY_API_KEY_FILE: file });
  });

  it('refuses a key file that others can read, a missing one, and an empty one', () => {
    const open = keyFile(0o644);
    assert.throws(() => readAgent({ AI_GATEWAY_API_KEY_FILE: open }), (error: UnusableAgentKey) => error instanceof UnusableAgentKey && error.fix === `chmod 600 ${open}`);
    assert.throws(() => readAgent({ AI_GATEWAY_API_KEY_FILE: '/nowhere/ai-gateway-key' }), (error: UnusableAgentKey) => error instanceof UnusableAgentKey && /does not exist/.test(error.what));
    const empty = keyFile(0o600, '\n');
    assert.throws(() => readAgent({ AI_GATEWAY_API_KEY_FILE: empty }), (error: UnusableAgentKey) => error instanceof UnusableAgentKey && /holds no key/.test(error.what));
    const directory = mkdtempSync(join(tmpdir(), 'verify-agent-key-dir-'));
    chmodSync(directory, 0o700);
    assert.throws(() => readAgent({ AI_GATEWAY_API_KEY_FILE: directory }), (error: UnusableAgentKey) => error instanceof UnusableAgentKey && /cannot be read \(EISDIR\)/.test(error.what));
    assert.equal(agentCheck(takeAgent({ AI_GATEWAY_API_KEY_FILE: directory })).ok, false, 'doctor reports it and does not crash');
    const check = agentCheck(takeAgent({ AI_GATEWAY_API_KEY_FILE: open }));
    assert.deepEqual({ id: check.id, ok: check.ok, fix: check.fix }, { id: 'agent', ok: false, fix: `chmod 600 ${open}` });
  });

  it('tells doctor the model and where the key came from', () => {
    assert.equal(agentCheck(takeAgent({ AI_GATEWAY_API_KEY: GATEWAY_KEY })).detail, 'anthropic/claude-haiku-5.5, with openai/gpt-6-luna-fast as its backup, through the Vercel AI Gateway; key from AI_GATEWAY_API_KEY');
    const file = keyFile(0o600);
    assert.equal(agentCheck(takeAgent({ AI_GATEWAY_API_KEY_FILE: file })).detail, 'anthropic/claude-haiku-5.5, with openai/gpt-6-luna-fast as its backup, through the Vercel AI Gateway; key from AI_GATEWAY_API_KEY_FILE');
  });
});
