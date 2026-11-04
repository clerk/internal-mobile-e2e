import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_API_HOST, createClerkBackends, type ClerkBackend } from '../clerk.ts';
import { currentProcess, isRunning, sleep as defaultSleep, type Runner } from '../exec.ts';
import type { InstanceKeys } from '../keys.ts';
import { count } from '../state.ts';
import { newEntryId, takeSlotLock, type Workspace } from '../workspace.ts';
import type { MinimumVersionRequest, SettingsRequest } from '../../../specs/support/types.ts';
import { VerifyFailure, type ApplicationView, type DoctorCheck, type InstanceView, type ProcessRef, type SettingsChangeRecord } from '../types.ts';
import { createPlatform, describeCredential, type Platform } from './platform.ts';
import { STANDARD_FILE, describeDifference } from './settings.ts';
import { createThrowaway, openApplications, standingLabel, type Changed, type HeldApplication, type LiveConfig, type Throwaway } from './throwaway.ts';

export interface Driving {
  readonly keys: InstanceKeys;
  readonly instance: { readonly id: string; readonly name: string };
  useSettings(request: SettingsRequest, at: string | null): Promise<Changed>;
  useMinimumAppVersion(request: MinimumVersionRequest, at: string | null): Promise<Changed>;
  restore(): Promise<void>;
  changes(): readonly SettingsChangeRecord[];
  stillStandard(): Promise<boolean>;
  release(): Promise<void>;
}

export interface Instances {
  access(): Promise<string>;
  ensure(progress: (line: string) => void): Promise<readonly InstanceView[]>;
  drive(): Promise<Driving>;
  keys(): InstanceKeys;
  clerk(): ClerkBackend;
  stopDriving(): Promise<void>;
  liveConfig(prefixes: readonly string[]): Promise<LiveConfig>;
  finish(ledger: Workspace, options: { readonly keepApplications: boolean }, progress: (line: string) => void): Promise<readonly ApplicationView[]>;
  doctorChecks(options: { readonly live: boolean }, progress: (line: string) => void): Promise<readonly DoctorCheck[]>;
}

export interface InstancesDeps {
  readonly workspace: Workspace;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: Runner;
  readonly progress: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly drivers?: { readonly self: ProcessRef; readonly isRunning: (driver: ProcessRef) => boolean };
}

export function check(id: DoctorCheck['id'], ok: boolean, detail: string, fix: string): DoctorCheck {
  return ok ? { id, ok, detail } : { id, ok, detail, fix };
}

export function createInstances(deps: InstancesDeps): Instances {
  const { workspace, env } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const backends = createClerkBackends(deps.fetch);
  const platform: Platform = createPlatform({ env, runner: deps.runner, progress: deps.progress, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }), sleep, ...(deps.now === undefined ? {} : { now: deps.now }) });
  const throwaway: Throwaway = createThrowaway({
    workspace,
    platform,
    clerk: backends,
    env,
    self: deps.drivers?.self ?? currentProcess(),
    isRunning: deps.drivers?.isRunning ?? isRunning,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    sleep,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  let reaching: Promise<string> | undefined;
  let driving: Driving | undefined;

  const current = (): Driving => {
    if (driving === undefined) throw new VerifyFailure('NOT_READY', 'no instance is driven: a spec asked for a user or a launch outside the part of a run that drives the device', 'report this as a verify bug');
    return driving;
  };
  const appliedClerk = backends(() => current().keys);

  async function reach(): Promise<string> {
    if (openApplications(workspace).length > 0) {
      await platform.credential();
      return 'this worktree already holds throwaway instances';
    }
    const open = await platform.open();
    return `${describeCredential(open.credential)} reaches the verification workspace ${open.workspace}`;
  }

  const access = (): Promise<string> => (reaching ??= reach());

  async function locked<T>(fn: () => T | Promise<T>): Promise<T> {
    mkdirSync(join(workspace.root, 'locks'), { recursive: true });
    const release = await takeSlotLock(
      join(workspace.root, 'locks', 'instances'),
      Number.POSITIVE_INFINITY,
      () => new VerifyFailure('NOT_READY', 'unreachable', ''),
      (owner) => deps.progress(`wait    another {cli} in this worktree (pid ${owner.pid}) is creating, changing, or deleting instances; waiting for it, with no time limit`),
    );
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const ownKeyAccepted = async (keys: InstanceKeys): Promise<void> => void (await backends(() => keys).userCount());

  async function settingsCheck(): Promise<DoctorCheck> {
    const details: string[] = [];
    const fixes: string[] = [];
    try {
      const inspected = await throwaway.inspect();
      if (inspected === null) details.push(`none created yet; up creates one application from ${STANDARD_FILE}`);
      else {
        const { id, standing } = inspected.application;
        const { found } = inspected;
        if (found === 'gone') {
          details.push(`Clerk no longer serves ${id}`);
          fixes.push('{cli} up creates a new application');
        } else if (standing.kind === 'unknown') {
          details.push(`${id} has no settings recorded`);
          fixes.push('{cli} up replaces it');
        } else if (standing.kind === 'changed') {
          details.push(`${id} has ${standingLabel(standing)}: ${standing.leaves.join(', ')}`);
          fixes.push('{cli} up restores them');
        } else if (found.differing.length > 0) {
          details.push(`${id} is recorded as on standard and shows ${found.differing.slice(0, 5).map((d) => describeDifference(d, 'those settings expect')).join('; ')}`);
          fixes.push('{cli} up returns it to the standard settings');
        } else {
          details.push(`${id} is on standard; ${found.compared} settings match ${STANDARD_FILE}`);
        }
      }
    } catch (error) {
      details.push(`could not read an environment: ${(error as Error).message}`);
      fixes.push('check network access to *.clerk.accounts.dev');
    }
    return check('settings', fixes.length === 0, details.join('; '), fixes.join('; '));
  }

  async function apiCheck(application: HeldApplication | null): Promise<DoctorCheck> {
    if (application === null) return check('clerk-api', true, `not observed yet: this worktree holds no application, so no call has used an instance's own key`, '');
    try {
      await ownKeyAccepted(await application.keys());
      return check('clerk-api', true, `${BACKEND_API_HOST} accepts the own key of ${application.id}`, '');
    } catch (error) {
      return check('clerk-api', false, (error as Error).message, error instanceof VerifyFailure ? error.fix : 'run `{cli} doctor` again');
    }
  }

  async function ensure(progress: (line: string) => void): Promise<readonly InstanceView[]> {
    progress(`instances ${await access()}`);
    const up = await throwaway.ensure(progress);
    if (up.created !== null) await ownKeyAccepted(await up.created.keys());
    return up.views;
  }

  async function finish(ledger: Workspace, options: { readonly keepApplications: boolean }, progress: (line: string) => void): Promise<readonly ApplicationView[]> {
    try {
      return options.keepApplications ? [] : await throwaway.finish(ledger, progress);
    } finally {
      for (const entry of ledger.unclosedEntries()) {
        if (entry.kind === 'user') ledger.append({ id: newEntryId(), kind: 'done', ref: entry.id });
      }
    }
  }

  function liveCheck(progress: (line: string) => void): Promise<readonly DoctorCheck[]> {
    return locked(async () => {
      const held = throwaway.held();
      if (held !== null) {
        return [await apiCheck(held), await settingsCheck(), { id: 'live-instance', ok: true, state: 'not-run', detail: `not run: this worktree already holds ${held.id}, which the checks above read` }];
      }
      const started = Date.now();
      try {
        const [made] = await ensure(progress);
        const api = await apiCheck(throwaway.held());
        const inspected = await settingsCheck();
        const finished = await finish(workspace, { keepApplications: false }, progress);
        const what = made === undefined ? 'an application' : `${made.id} (${made.name})`;
        return [api, inspected, check('live-instance', api.ok, `created ${what}, configured it, compared its environment, and deleted it (${count(finished.length, 'application')} gone from the list) in ${Math.round((Date.now() - started) / 1000)}s`, api.fix ?? '')];
      } catch (error) {
        const failure = error instanceof VerifyFailure ? error : new VerifyFailure('NOT_READY', (error as Error).message, '{cli} down deletes anything it left');
        await finish(workspace, { keepApplications: false }, progress).catch(() => undefined);
        return [check('live-instance', false, failure.message, failure.fix)];
      }
    });
  }

  return {
    access,
    keys: () => current().keys,
    clerk: () => {
      current();
      return appliedClerk;
    },
    ensure: (progress) => locked(() => ensure(progress)),

    async drive() {
      if (driving !== undefined) throw new Error('an instance is still driven: release it before driving it again');
      const application = await locked(() => throwaway.drive());
      let changes: readonly SettingsChangeRecord[] = [];
      driving = {
        keys: application.keys,
        instance: { id: application.id, name: application.name },
        async useSettings(request, at) {
          const made = await locked(() => throwaway.change(request, at, deps.progress));
          changes = [...changes, { at, changed: made.changed, shown: made.shown, restored: made.changed.length === 0 }];
          return made;
        },
        async useMinimumAppVersion(request, at) {
          const made = await locked(() => throwaway.changeMinimumVersion(request, at, deps.progress));
          changes = [...changes, { at, changed: made.changed, shown: made.shown, restored: made.changed.length === 0 }];
          return made;
        },
        async restore() {
          await locked(() => throwaway.restore(deps.progress));
          changes = changes.map((change) => ({ ...change, restored: true }));
        },
        changes: () => changes,
        stillStandard: application.stillStandard,
        release: async () => {
          driving = undefined;
        },
      };
      return driving;
    },

    stopDriving: () => locked(throwaway.stopDriving),

    liveConfig: (prefixes) => throwaway.liveConfig(prefixes),

    finish: (ledger, options, progress) => (ledger.root === workspace.root ? locked(() => finish(ledger, options, progress)) : finish(ledger, options, progress)),

    async doctorChecks(options, progress) {
      const failed = (error: unknown, prefix = ''): DoctorCheck => {
        const failure = error instanceof VerifyFailure ? error : new VerifyFailure('NOT_READY', (error as Error).message, 'run `{cli} doctor` again');
        return check('instances', false, `${prefix}${failure.message}`, failure.fix);
      };
      const held = throwaway.held();
      const holding = held === null ? 'none created yet' : `${held.id} (${held.name}) on ${standingLabel(held.standing)}`;
      let reaches: DoctorCheck;
      try {
        await platform.requireScopes();
        const open = await platform.open();
        reaches = check('instances', true, `${describeCredential(open.credential)} reaches the verification workspace ${open.workspace}; ${holding}`, '');
      } catch (error) {
        if (openApplications(workspace).length === 0) return [failed(error)];
        reaches = failed(error, `${holding}; `);
      }
      if (options.live && reaches.ok) return [reaches, ...(await liveCheck(progress))];
      return [reaches, await apiCheck(held), await settingsCheck()];
    },
  };
}
