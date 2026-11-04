import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVELOPMENT_USER_LIMIT, REPLACE_AT_USERS, frontendApiHost, type ClerkBackend } from '../clerk.ts';
import { sleep as defaultSleep } from '../exec.ts';
import type { InstanceKeys } from '../keys.ts';
import { count } from '../state.ts';
import { newEntryId, type Workspace } from '../workspace.ts';
import { VerifyFailure, type ApplicationView, type InstanceView, type Json, type LedgerEntry, type ProcessRef, type PublishableKey } from '../types.ts';
import type { MinimumVersionRequest, NativeAppPlatform, SettingsRequest } from '../../../specs/support/types.ts';
import { deadlineOf, throwawayApplication, throwawayName, type AppRef, type Listing, type OpenWorkspace, type Platform } from './platform.ts';
import {
  BASE_KEY,
  STANDARD_FILE,
  SettingsNotShown,
  SettingsRefused,
  compareEnvironment,
  isNativeAppPlatform,
  compareLeaves,
  configLeaves,
  describeDifference,
  flattenEnvironment,
  nest,
  sameLeaf,
  standardFile,
  underneath,
  type EnvironmentComparison,
  type LeafChange,
  type Leaves,
  type Snapshot,
} from './settings.ts';

type ApplicationEntry = Extract<LedgerEntry, { kind: 'application' }>;

interface InstanceRecord {
  readonly application: string;
  readonly instanceId: string;
  readonly publishableKey: PublishableKey;
}

interface Held {
  readonly entry: ApplicationEntry;
  readonly record: InstanceRecord;
}

type ApplicationState =
  | { readonly known: false; readonly drivers: readonly ProcessRef[] }
  | { readonly known: true; readonly baseKey: string; readonly pending: Snapshot | null; readonly drivers: readonly ProcessRef[] };

type KnownState = Extract<ApplicationState, { known: true }>;

const DEFAULT_LIFETIME_HOURS = 6;
const LIFETIME_HOURS = { min: 2, max: 72 } as const;
const REPLACE_WITHIN_MS = 60 * 60_000;
const REAP_GRACE_MS = 5 * 60_000;
const REAP_PER_COMMAND = 5;
const REDACTED = 'REDACTED';
const SHOWN_WITHIN_MS = 15_000;
const KEYS_LISTED = 12;

export interface ThrowawayDeps {
  readonly workspace: Workspace;
  readonly platform: Platform;
  readonly clerk: (keys: () => InstanceKeys) => ClerkBackend;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly self: ProcessRef;
  readonly isRunning: (driver: ProcessRef) => boolean;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export type Standing = { readonly kind: 'unknown' } | { readonly kind: 'standard' } | { readonly kind: 'changed'; readonly leaves: readonly string[] };

export function standingLabel(standing: Standing): string {
  switch (standing.kind) {
    case 'unknown':
      return 'unknown settings';
    case 'standard':
      return 'standard';
    case 'changed':
      return `${standing.leaves.length === 1 ? '1 leaf' : `${standing.leaves.length} leaves`} a test changed, not restored`;
    default: {
      const exhaustive: never = standing;
      return exhaustive;
    }
  }
}

export interface Changed {
  readonly changed: readonly LeafChange[];
  readonly shown: readonly string[];
}

export interface HeldApplication {
  readonly id: string;
  readonly name: string;
  readonly standing: Standing;
  keys(): Promise<InstanceKeys>;
}

export interface DrivenApplication {
  readonly id: string;
  readonly name: string;
  readonly keys: InstanceKeys;
  stillStandard(): Promise<boolean>;
}

export interface Inspection {
  readonly application: HeldApplication;
  readonly found: EnvironmentComparison | 'gone';
}

export interface LiveConfig {
  readonly application: { readonly id: string; readonly name: string };
  readonly pending: readonly string[] | null;
  readonly config: Leaves;
}

export interface Throwaway {
  held(): HeldApplication | null;
  ensure(progress: (line: string) => void): Promise<{ readonly views: readonly InstanceView[]; readonly created: HeldApplication | null }>;
  drive(): Promise<DrivenApplication>;
  change(request: SettingsRequest, at: string | null, progress: (line: string) => void): Promise<Changed>;
  changeMinimumVersion(request: MinimumVersionRequest, at: string | null, progress: (line: string) => void): Promise<Changed>;
  restore(progress: (line: string) => void): Promise<readonly string[]>;
  stopDriving(): void;
  inspect(): Promise<Inspection | null>;
  liveConfig(prefixes: readonly string[]): Promise<LiveConfig>;
  finish(ledger: Workspace, progress: (line: string) => void): Promise<readonly ApplicationView[]>;
}

export const openApplications = (ledger: Workspace): readonly ApplicationEntry[] => ledger.unclosedEntries().filter((entry): entry is ApplicationEntry => entry.kind === 'application');

const recordsDir = (ledger: Workspace): string => join(ledger.root, 'instances');
const recordFile = (ledger: Workspace, name: string): string => join(recordsDir(ledger), `${name}.json`);
const stateFile = (ledger: Workspace, name: string): string => join(recordsDir(ledger), `${name}.state.json`);

function writeWhole(file: string, text: string): void {
  const staged = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(staged, text, { mode: 0o600 });
  renameSync(staged, file);
}

function readRecord(ledger: Workspace, name: string): InstanceRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordFile(ledger, name), 'utf8')) as Partial<InstanceRecord> | null;
    if (typeof raw?.application !== 'string' || typeof raw.instanceId !== 'string' || typeof raw.publishableKey !== 'string') return null;
    return { application: raw.application, instanceId: raw.instanceId, publishableKey: raw.publishableKey };
  } catch {
    return null;
  }
}

const UNKNOWN: ApplicationState = { known: false, drivers: [] };

const MINIMUM_VERSIONS_KEY = 'native_app_minimum_versions';
const minimumVersionShown = (os: NativeAppPlatform): string => `native_app_settings.minimum_supported_version.${os}`;
const pendingNames = (pending: Snapshot): readonly string[] => [...Object.keys(pending.config), ...(pending.minimumVersions ?? []).map((os) => `${MINIMUM_VERSIONS_KEY}.${os}`)];

const isLeaves = (value: unknown): value is Leaves => typeof value === 'object' && value !== null && !Array.isArray(value);

function snapshotOf(raw: unknown): Snapshot | null | undefined {
  if (raw === null) return null;
  const { config, sections, environment, minimumVersions } = (raw ?? {}) as { config?: unknown; sections?: unknown; environment?: unknown; minimumVersions?: unknown };
  if (!isLeaves(config) || !isLeaves(sections) || !isLeaves(environment)) return undefined;
  if (minimumVersions === undefined) return { config, sections, environment };
  return Array.isArray(minimumVersions) && minimumVersions.every(isNativeAppPlatform) ? { config, sections, environment, minimumVersions } : undefined;
}

function readState(ledger: Workspace, name: string): ApplicationState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(ledger, name), 'utf8')) as { baseKey?: unknown; pending?: unknown; drivers?: unknown } | null;
    if (typeof raw !== 'object' || raw === null) return UNKNOWN;
    const drivers = Array.isArray(raw.drivers) ? (raw.drivers as Partial<ProcessRef>[]).flatMap((driver) => (typeof driver?.pid === 'number' && typeof driver.startedAt === 'number' ? [{ pid: driver.pid, startedAt: driver.startedAt }] : [])) : [];
    const pending = snapshotOf(raw.pending);
    if (typeof raw.baseKey !== 'string' || pending === undefined) return { known: false, drivers };
    return { known: true, baseKey: raw.baseKey, pending, drivers };
  } catch {
    return UNKNOWN;
  }
}

function writeState(ledger: Workspace, name: string, state: ApplicationState): void {
  const body = state.known ? { baseKey: state.baseKey, pending: state.pending, drivers: state.drivers } : { drivers: state.drivers };
  writeWhole(stateFile(ledger, name), `${JSON.stringify(body)}\n`);
}

function lifetimeMs(env: ThrowawayDeps['env']): number {
  const raw = env.VERIFY_THROWAWAY_HOURS;
  if (raw === undefined || raw === '') return DEFAULT_LIFETIME_HOURS * 3_600_000;
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < LIFETIME_HOURS.min || hours > LIFETIME_HOURS.max) {
    throw new VerifyFailure('USAGE', `VERIFY_THROWAWAY_HOURS=${raw} is not a whole number from ${LIFETIME_HOURS.min} to ${LIFETIME_HOURS.max}`, 'unset VERIFY_THROWAWAY_HOURS or set it within range');
  }
  return hours * 3_600_000;
}

const compareWithStandard = (live: Json): EnvironmentComparison => compareEnvironment(standardFile().environment, live);

interface Moved {
  readonly compared: number;
  readonly answeredMs: number;
  readonly visibleMs: number;
}

const nearDeadline = (name: string, at: number): boolean => {
  const deadline = deadlineOf(name);
  return deadline !== null && deadline.getTime() - at < REPLACE_WITHIN_MS;
};

const seconds = (ms: number, digits: number): string => `${(ms / 1000).toFixed(digits)}s`;

const listed = (keys: readonly string[]): string => `${keys.slice(0, KEYS_LISTED).join(', ')}${keys.length > KEYS_LISTED ? `, and ${keys.length - KEYS_LISTED} more` : ''}`;

const asShown = (leaves: Leaves): Leaves => Object.fromEntries(Object.entries(leaves).map(([leaf, value]) => [leaf, Array.isArray(value) ? value.map(String).sort() : value]));

const assigned = (changes: readonly { readonly leaf: string; readonly to: Json }[]): string => changes.map((change) => `${change.leaf}=${JSON.stringify(change.to)}`).join(', ');

function besideMissing(leaf: string, after: Json): string {
  const segments = leaf.split('.');
  let node: Json = after;
  let depth = 0;
  while (depth < segments.length - 1 && isLeaves(node) && Object.hasOwn(node, segments[depth]!)) node = (node as Leaves)[segments[depth++]!]!;
  if (!isLeaves(node) || depth === 0) return '';
  return `; Clerk has ${listed(Object.keys(node).sort())} under \`${segments.slice(0, depth).join('.')}\``;
}

export function createThrowaway(deps: ThrowawayDeps): Throwaway {
  const { workspace, platform, self } = deps;
  const request = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let listedOnce = false;
  const secretKeys = new Map<string, Promise<InstanceKeys['sk']>>();

  const close = (ledger: Workspace, entry: ApplicationEntry): void => {
    const dir = recordsDir(ledger);
    const files = existsSync(dir) ? readdirSync(dir).filter((file) => file.startsWith(`${entry.name}.`)) : [];
    for (const file of files) rmSync(join(dir, file), { force: true });
    ledger.append({ id: newEntryId(), kind: 'done', ref: entry.id });
  };

  function pool(): { readonly held: Held | null; readonly strays: readonly ApplicationEntry[] } {
    let held: Held | null = null;
    const strays: ApplicationEntry[] = [];
    for (const entry of openApplications(workspace)) {
      const record = readRecord(workspace, entry.name);
      if (record === null) strays.push(entry);
      else held ??= { entry, record };
    }
    return { held, strays };
  }

  async function keysOf(app: Held): Promise<InstanceKeys> {
    const id = app.record.application;
    let sk = secretKeys.get(id);
    if (sk === undefined) {
      sk = platform.secretKey(throwawayApplication(id, app.entry.name));
      secretKeys.set(id, sk);
    }
    return { pk: app.record.publishableKey, sk: await sk };
  }
  const standingOf = (state: ApplicationState): Standing => (!state.known ? { kind: 'unknown' } : state.pending === null ? { kind: 'standard' } : { kind: 'changed', leaves: pendingNames(state.pending) });
  const describe = (app: Held, state: ApplicationState): HeldApplication => ({ id: app.record.application, name: app.entry.name, standing: standingOf(state), keys: () => keysOf(app) });
  const otherDrivers = (state: ApplicationState): readonly ProcessRef[] => state.drivers.filter((driver) => driver.pid !== self.pid && deps.isRunning(driver));

  async function environment(pk: PublishableKey): Promise<{ readonly status: number; readonly json: Json; readonly at: number }> {
    const response = await request(`https://${frontendApiHost(pk)}/v1/environment`, { signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    const date = Date.parse(response.headers.get('date') ?? '');
    let json: Json = null;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = null;
    }
    return { status: response.status, json, at: Number.isNaN(date) ? now() : date };
  }

  async function listing(open: OpenWorkspace): Promise<Listing> {
    if (listedOnce) return open.list();
    listedOnce = true;
    return open.opened;
  }

  const unanswered = (app: Held, status: number): VerifyFailure =>
    new VerifyFailure('NOT_READY', `the Frontend API of ${app.record.application} (${app.entry.name}) answered ${status}`, 'rerun; a cloud environment needs *.clerk.accounts.dev in its allowed domains');

  const standardRefused = (said: string): VerifyFailure =>
    new VerifyFailure('INSTANCE_MISCONFIGURED', `Clerk's Platform API refused the standard settings in ${STANDARD_FILE}: ${said}`, 'the standard file needs a change of its own; the spec is not at fault');

  function notShown(app: Held, status: number, compared: EnvironmentComparison | null): VerifyFailure {
    const id = app.record.application;
    if (compared === null) return new VerifyFailure('NOT_READY', `the Frontend API of ${id} (${app.entry.name}) answered ${status} after its settings were changed`, 'rerun; a cloud environment needs *.clerk.accounts.dev in its allowed domains');
    return new VerifyFailure(
      'INSTANCE_MISCONFIGURED',
      `${id} (${app.entry.name}) does not match ${STANDARD_FILE} after it was configured: ${compared.differing.slice(0, 5).map((d) => describeDifference(d)).join('; ')}`,
      '`{cli} down`, then rerun once; if it repeats, Clerk changed what a setting does, and the file needs a change of its own, apart from the work being verified',
    );
  }

  type Verdict = { readonly keep: 'as-is' | 'busy' } | { readonly restore: string; readonly state: KnownState } | { readonly repair: string } | { readonly retire: string };

  async function toStandard(open: OpenWorkspace, app: Held): Promise<Moved> {
    const name = app.entry.name;
    const before = readState(workspace, name);
    const body = standardFile().config;
    const started = now();
    let answer: { readonly after: Json };
    try {
      answer = await open.configure({ application: throwawayApplication(app.record.application, name), instanceId: app.record.instanceId }, body);
    } catch (error) {
      throw error instanceof SettingsRefused ? standardRefused(error.said) : error;
    }
    const answered = now();
    const after = configLeaves(answer.after);
    const lost = Object.entries(configLeaves(body)).find(([leaf, value]) => !sameLeaf(after[leaf], value));
    if (lost !== undefined) {
      throw new VerifyFailure(
        'INSTANCE_MISCONFIGURED',
        `Clerk accepted the settings for ${app.record.application} and its answer does not hold ${lost[0]}=${JSON.stringify(lost[1])} (it has ${after[lost[0]] === undefined ? 'no such key' : JSON.stringify(after[lost[0]])})`,
        'rerun once; if it repeats, the Platform API changed how it answers a config change, which is a verify bug to report',
      );
    }
    const until = answered + SHOWN_WITHIN_MS;
    for (;;) {
      const live = await environment(app.record.publishableKey);
      const compared = live.status !== 200 ? null : compareWithStandard(live.json);
      if (compared !== null && compared.differing.length === 0) {
        writeState(workspace, name, { known: true, baseKey: BASE_KEY, pending: null, drivers: before.drivers });
        return { compared: compared.compared, answeredMs: answered - started, visibleMs: now() - answered };
      }
      if (now() >= until) throw notShown(app, live.status, compared);
      await sleep(500);
    }
  }

  const refOf = (app: Held): AppRef => ({ application: throwawayApplication(app.record.application, app.entry.name), instanceId: app.record.instanceId });

  async function shownLeaves(app: Held): Promise<Leaves> {
    const live = await environment(app.record.publishableKey);
    if (live.status !== 200) throw unanswered(app, live.status);
    return flattenEnvironment(live.json);
  }

  async function waitShown(app: Held, expected: Leaves | null, before: Leaves, notShown: (unmet: string) => VerifyFailure): Promise<readonly string[]> {
    const wanted = expected === null ? null : asShown(expected);
    const until = now() + SHOWN_WITHIN_MS;
    for (;;) {
      const live = await environment(app.record.publishableKey);
      if (live.status === 200) {
        const shown = flattenEnvironment(live.json);
        if (wanted !== null) {
          const unmet = compareLeaves(wanted, shown);
          if (unmet.length === 0) return Object.keys(wanted);
          if (now() >= until) throw notShown(unmet.slice(0, 5).map((d) => describeDifference(d, 'it should be')).join('; '));
        } else {
          const moved = [...new Set([...Object.keys(before), ...Object.keys(shown)])].filter((leaf) => JSON.stringify(before[leaf]) !== JSON.stringify(shown[leaf])).sort();
          if (moved.length > 0) return moved;
          if (now() >= until) return [];
        }
      } else if (now() >= until) {
        throw unanswered(app, live.status);
      }
      await sleep(500);
    }
  }

  function asked(where: string, request: SettingsRequest, asking: string, refusal: SettingsRefused): SettingsRefused {
    const leaves = Object.keys(request.config);
    const { param } = refusal;
    const fix =
      param === null
        ? `Clerk refused these together; remove or correct one of ${leaves.join(', ')}`
        : leaves.some((leaf) => leaf === param || leaf.endsWith(`.${param}`))
          ? `correct \`${param}\` in config: Clerk says what is wrong with it above`
          : `add \`${param}\` to config, since Clerk requires it with what the call asks for, or remove what requires it`;
    return new SettingsRefused(`${where} asks for ${asking}, and Clerk's Platform API refused it: ${refusal.said}`, fix, refusal);
  }

  async function change(app: Held, request: SettingsRequest, at: string | null, progress: (line: string) => void): Promise<Changed> {
    const id = app.record.application;
    const where = at ?? 'host.useSettings';
    const asking = assigned(Object.entries(request.config).map(([leaf, to]) => ({ leaf, to })));
    const state = readState(workspace, app.entry.name);
    if (!state.known) throw new VerifyFailure('INSTANCE_MISCONFIGURED', `what ${id} is on is not recorded, so a change to it could not be put back`, '{cli} up replaces it, then rerun');
    const open = await platform.open();
    const before = await shownLeaves(app);
    const dry = await open.configure(refOf(app), nest(request.config), { dryRun: true }).catch((error: unknown) => {
      throw error instanceof SettingsRefused ? asked(where, request, asking, error) : error;
    });
    const was = configLeaves(dry.before);
    const will = configLeaves(dry.after);
    for (const [leaf, value] of Object.entries(request.config)) {
      if (!Object.hasOwn(will, leaf)) throw new SettingsRefused(`${where} asks for ${leaf}, and the instance config has no such leaf`, `check the spelling with \`{cli} settings ${leaf.split('.')[0]}\`${besideMissing(leaf, dry.after)}`);
      if (!sameLeaf(will[leaf], value)) throw new SettingsRefused(`${where} asks for ${leaf}=${JSON.stringify(value)}, and Clerk would store ${JSON.stringify(will[leaf])}`, `ask for a value Clerk keeps; \`{cli} settings ${leaf}\` prints the value it has now`);
    }
    const moved = Object.entries(will).filter(([leaf, value]) => !sameLeaf(was[leaf], value));
    const unset = moved.find(([leaf]) => !Object.hasOwn(was, leaf));
    if (unset !== undefined) throw new SettingsRefused(`${where} asks for ${Object.keys(request.config).join(', ')}, and Clerk would set ${unset[0]}, which has no value before the change, so it could not be put back`, 'change leaves that have a value now; `{cli} settings` lists them');
    const changed: readonly LeafChange[] = moved.map(([leaf, to]) => ({ leaf, from: was[leaf]!, to }));
    if (changed.length === 0) {
      progress(`settings ${asking}  already on ${id}, for ${where}`);
      return { changed, shown: [] };
    }
    const declared = request.environment ?? null;
    if (declared !== null && compareLeaves(asShown(declared), before).length === 0) {
      throw new SettingsRefused(`${where} expects ${Object.keys(declared).join(', ')} to show the change, and the environment shows those values before it`, 'name environment leaves the change moves, or leave environment out and the CLI waits for any leaf to change');
    }
    const pending = underneath(state.pending, { config: Object.fromEntries(changed.map((c) => [c.leaf, c.from])), sections: was, environment: {} });
    writeState(workspace, app.entry.name, { ...state, pending });
    const started = now();
    const answer = await open.configure(refOf(app), nest(request.config));
    const stored = configLeaves(answer.after);
    const lost = changed.find((c) => !sameLeaf(stored[c.leaf], c.to));
    if (lost !== undefined) throw new VerifyFailure('INSTANCE_MISCONFIGURED', `Clerk accepted ${lost.leaf}=${JSON.stringify(lost.to)} for ${id} on a dry run, and its answer to the change holds ${JSON.stringify(stored[lost.leaf] ?? null)}`, 'rerun once; if it repeats, report this as a verify bug');
    const shown = await waitShown(app, declared, before, (unmet) => new SettingsNotShown(`${where} changed ${assigned(changed)} on ${id}, and ${seconds(SHOWN_WITHIN_MS, 0)} later the environment does not show it: ${unmet}`, 'correct environment to the leaves and values the change shows, or leave it out and the CLI waits for any leaf to change'));
    const after = shown.length === 0 ? before : await shownLeaves(app);
    const movedLeaves = Object.keys({ ...before, ...after }).filter((leaf) => JSON.stringify(before[leaf]) !== JSON.stringify(after[leaf]));
    const wasShown = Object.fromEntries([...new Set([...shown, ...movedLeaves])].flatMap((leaf) => (Object.hasOwn(before, leaf) ? [[leaf, before[leaf]!]] : [])));
    writeState(workspace, app.entry.name, { ...state, pending: underneath(pending, { config: {}, sections: {}, environment: wasShown }) });
    progress(`settings ${assigned(changed)}  on ${id} for ${where}; the environment showed ${shown.length === 0 ? 'no change' : shown.join(', ')} ${seconds(now() - started, 1)} later`);
    if (shown.length === 0 && declared === null) progress(`settings no leaf of the public environment changed within ${seconds(SHOWN_WITHIN_MS, 0)}; if the app reads this setting, pass environment so the wait can check it`);
    return { changed, shown };
  }

  async function changeMinimumVersion(app: Held, request: MinimumVersionRequest, at: string | null, progress: (line: string) => void): Promise<Changed> {
    const id = app.record.application;
    const where = at ?? 'host.useMinimumAppVersion';
    const { platform: os, id: appId } = request.app;
    const leaf = `${MINIMUM_VERSIONS_KEY}.${os}.${appId}.minimum_version`;
    const state = readState(workspace, app.entry.name);
    if (!state.known) throw new VerifyFailure('INSTANCE_MISCONFIGURED', `what ${id} is on is not recorded, so a change to it could not be put back`, '{cli} up replaces it');
    const open = await platform.open();
    const before = await shownLeaves(app);
    await open.registerNativeApp(refOf(app), request.app);
    writeState(workspace, app.entry.name, { ...state, pending: underneath(state.pending, { config: {}, sections: {}, environment: {}, minimumVersions: [os] }) });
    const started = now();
    await open.configure(refOf(app), { [MINIMUM_VERSIONS_KEY]: { [os]: { [appId]: { minimum_version: request.minimumVersion, update_url: request.updateUrl } } } }).catch((error: unknown) => {
      throw error instanceof SettingsRefused ? new SettingsRefused(`${where} asks for ${leaf}=${JSON.stringify(request.minimumVersion)}, and Clerk's Platform API refused it: ${error.said}`, 'correct the version or the URL: Clerk says what is wrong above', { param: error.param, said: error.said }) : error;
    });
    const shows = `${minimumVersionShown(os)}[0].minimum_version`;
    const shown = await waitShown(app, { [shows]: request.minimumVersion, [`${minimumVersionShown(os)}[0].update_url`]: request.updateUrl }, before, (unmet) => new SettingsNotShown(`${where} set ${leaf}=${JSON.stringify(request.minimumVersion)} on ${id}, and ${seconds(SHOWN_WITHIN_MS, 0)} later the public environment did not show it: ${unmet}`, 'run it again; if it fails again, the instance may not have the native_app_force_update flag'));
    progress(`settings ${leaf}=${JSON.stringify(request.minimumVersion)}  on ${id} for ${where}; the environment showed ${shows} ${seconds(now() - started, 1)} later`);
    return { changed: [{ leaf, from: before[shows] ?? null, to: request.minimumVersion }], shown };
  }

  async function restore(app: Held, progress: (line: string) => void): Promise<readonly string[]> {
    const state = readState(workspace, app.entry.name);
    if (!state.known || state.pending === null) return [];
    const { pending } = state;
    const open = await platform.open();
    const id = app.record.application;
    const leaves = pendingNames(pending);
    const before = await shownLeaves(app);
    const minimums = pending.minimumVersions ?? [];
    if (minimums.length > 0) await open.configure(refOf(app), { [MINIMUM_VERSIONS_KEY]: Object.fromEntries(minimums.map((os) => [os, null])) }, { destructive: true });
    // Clerk moves other leaves of a section when one changes back: turning organizations on turns forced selection on.
    const written = { ...pending.sections, ...pending.config };
    if (Object.keys(written).length > 0) {
      const answer = await open.configure(refOf(app), nest(written));
      const stored = configLeaves(answer.after);
      const lost = Object.keys(written).find((leaf) => written[leaf] !== REDACTED && !sameLeaf(stored[leaf], written[leaf]));
      if (lost !== undefined) throw new SettingsRefused(`Clerk accepted ${lost}=${JSON.stringify(written[lost])} to restore ${id}, and its answer holds ${JSON.stringify(stored[lost] ?? null)}`, '{cli} up replaces the application');
    }
    const shownBack = { ...pending.environment, ...Object.fromEntries(minimums.map((os) => [minimumVersionShown(os), []])) };
    const expected = Object.keys(shownBack).length === 0 ? null : shownBack;
    await waitShown(app, expected, before, (unmet) => new SettingsNotShown(`${id} was put back to ${listed(leaves)}, and ${seconds(SHOWN_WITHIN_MS, 0)} later the environment does not show what it showed before: ${unmet}`, '{cli} up replaces the application'));
    writeState(workspace, app.entry.name, { ...state, pending: null });
    progress(`settings restored ${listed(leaves)} on ${id}`);
    return leaves;
  }

  const drift = (state: KnownState, live: Json): Exclude<Verdict, { readonly retire: string }> =>
    state.baseKey !== BASE_KEY ? { repair: `${STANDARD_FILE} changed since it was configured` } : compareWithStandard(live).differing.length > 0 ? { repair: 'it no longer shows standard' } : { keep: 'as-is' };

  const changedLine = (id: string, moved: Moved): string =>
    `settings standard  on ${id} in ${seconds(moved.answeredMs + moved.visibleMs, 1)} (Clerk answered in ${seconds(moved.answeredMs, 2)}, the instance showed it ${seconds(moved.visibleMs, 2)} later), ${moved.compared} settings match`;

  async function create(open: OpenWorkspace, at: Date | null, progress: (line: string) => void): Promise<Held> {
    const name = throwawayName(new Date((at?.getTime() ?? now()) + lifetimeMs(deps.env)), randomBytes(4).toString('hex'));
    const entry: ApplicationEntry = { id: newEntryId(), kind: 'application', name, workspace: open.workspace };
    workspace.append(entry);
    progress(`instance creating ${name} in ${open.workspace}`);
    const started = now();
    const created = await open.create(name);
    const record: InstanceRecord = { application: created.application.id, instanceId: created.instanceId, publishableKey: created.pk };
    mkdirSync(recordsDir(workspace), { recursive: true, mode: 0o700 });
    writeFileSync(recordFile(workspace, name), `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    secretKeys.set(record.application, Promise.resolve(created.sk));
    const app: Held = { entry, record };
    const moved = await toStandard(open, app);
    progress(`instance ${record.application}  up in ${seconds(now() - started, 1)} on standard, ${moved.compared} settings match ${STANDARD_FILE}`);
    return app;
  }

  async function reap(open: OpenWorkspace, listed: Listing, progress: (line: string) => void): Promise<void> {
    const at = listed.at;
    if (at === null) return;
    const mine = new Set(openApplications(workspace).map((entry) => entry.name));
    const expired = listed.applications.filter((application) => {
      const deadline = deadlineOf(application.name);
      return !mine.has(application.name) && deadline !== null && deadline.getTime() + REAP_GRACE_MS < at.getTime();
    });
    for (const application of expired.slice(0, REAP_PER_COMMAND)) {
      try {
        await open.delete(application);
        progress(`reap    ${application.name}  (its deadline passed and the session that made it never deleted it)`);
      } catch (error) {
        progress(`reap    ${application.name} left in place: ${(error as Error).message}`);
      }
    }
    if (expired.length > REAP_PER_COMMAND) progress(`reap    ${expired.length - REAP_PER_COMMAND} more expired applications are left for the next command`);
  }

  async function judge(app: Held, state: ApplicationState): Promise<Verdict> {
    if (otherDrivers(state).length > 0) return { keep: 'busy' };
    const live = await environment(app.record.publishableKey);
    if (live.status === 404) return { retire: 'Clerk no longer serves it' };
    if (live.status !== 200) throw unanswered(app, live.status);
    if (nearDeadline(app.entry.name, live.at)) return { retire: 'its deadline is near' };
    const keys = await keysOf(app);
    const users = await deps.clerk(() => keys).userCount();
    if (users >= REPLACE_AT_USERS) return { retire: `it holds ${users} of the ${DEVELOPMENT_USER_LIMIT} users a development instance allows` };
    if (!state.known) return { retire: `what it is on is not recorded, and a test may have changed settings ${STANDARD_FILE} does not name` };
    if (state.pending !== null) return { restore: `a run ended without restoring ${listed(pendingNames(state.pending))}`, state };
    return drift(state, live.json);
  }

  return {
    held: () => {
      const app = pool().held;
      return app === null ? null : describe(app, readState(workspace, app.entry.name));
    },

    async inspect() {
      const app = pool().held;
      if (app === null) return null;
      const state = readState(workspace, app.entry.name);
      const live = await environment(app.record.publishableKey);
      if (live.status !== 200 && live.status !== 404) throw new Error(`the Frontend API of ${app.record.application} answered ${live.status}`);
      return { application: describe(app, state), found: live.status === 404 ? 'gone' : compareWithStandard(live.json) };
    },

    async ensure(progress) {
      lifetimeMs(deps.env);
      const { held, strays } = pool();
      const state = held === null ? UNKNOWN : readState(workspace, held.entry.name);
      const verdict = held === null ? null : await judge(held, state);
      let kept = held !== null && verdict !== null && !('retire' in verdict) ? { app: held, verdict } : null;
      if (kept !== null && 'keep' in kept.verdict) {
        progress(`instance ${kept.app.record.application}  held, on ${standingLabel(standingOf(state))}${kept.verdict.keep === 'busy' ? ', and another run in this worktree is driving on it' : ''}`);
      }
      const view = (app: Held, created: boolean): InstanceView => ({ id: app.record.application, name: app.entry.name, created, settings: standingLabel(standingOf(readState(workspace, app.entry.name))) });
      if (strays.length === 0 && kept !== null && 'keep' in kept.verdict) return { views: [view(kept.app, false)], created: null };

      const open = await platform.open();
      const listed = await listing(open);
      const byName = new Map(listed.applications.map((application) => [application.name, application]));
      const retired = new Set<string>();
      const retire = async (entry: ApplicationEntry, id: string | null, why: string): Promise<void> => {
        const application = byName.get(entry.name) ?? (id === null ? undefined : throwawayApplication(id, entry.name));
        if (application !== undefined) await open.delete(application);
        close(workspace, entry);
        retired.add(entry.name);
        progress(`instance ${id ?? entry.name} retired (${why})`);
      };
      for (const entry of strays) await retire(entry, null, 'its keys are lost');
      if (held !== null && verdict !== null && 'retire' in verdict) await retire(held.entry, held.record.application, verdict.retire);

      let failure: unknown;
      if (kept !== null && 'restore' in kept.verdict) {
        const { app } = kept;
        progress(`settings restoring ${app.record.application}, because ${kept.verdict.restore}`);
        try {
          await restore(app, progress);
          const live = await environment(app.record.publishableKey);
          kept = { app, verdict: drift({ ...kept.verdict.state, pending: null }, live.json) };
        } catch (error) {
          if (!(error instanceof SettingsRefused || error instanceof SettingsNotShown)) throw error;
          await retire(app.entry, app.record.application, `the settings a test changed could not be restored: ${error.message}`);
          kept = null;
        }
      }
      if (kept !== null && 'repair' in kept.verdict) {
        progress(`settings changing ${kept.app.record.application} from ${standingLabel(standingOf(state))} to standard, because ${kept.verdict.repair}`);
        const { app } = kept;
        await toStandard(open, app).then((moved) => progress(changedLine(app.record.application, moved)), (error: unknown) => (failure = error));
      }
      let created: Held | null = null;
      if (kept === null) created = await create(open, listed.at, progress).catch((error: unknown) => ((failure = error), null));

      await reap(open, { ...listed, applications: listed.applications.filter((application) => !retired.has(application.name)) }, progress);
      if (failure !== undefined) throw failure;
      return { views: [...(kept === null ? [] : [view(kept.app, false)]), ...(created === null ? [] : [view(created, true)])], created: created === null ? null : describe(created, readState(workspace, created.entry.name)) };
    },

    async drive() {
      const app = pool().held;
      if (app === null) throw new VerifyFailure('NOT_READY', 'this worktree holds no application for a run to drive on', '{cli} up');
      const id = app.record.application;
      const name = app.entry.name;
      const state = readState(workspace, name);
      const other = otherDrivers(state)[0];
      if (other !== undefined) {
        throw new VerifyFailure('DEVICE_BUSY', `another run in this worktree (pid ${other.pid}) is driving on ${id}, and a worktree has one application, which serves one run at a time`, 'let that run finish, then rerun');
      }
      const keys = await keysOf(app);
      writeState(workspace, name, { ...state, drivers: [self] });
      return {
        id,
        name,
        keys,
        async stillStandard() {
          const shown = await environment(app.record.publishableKey);
          if (shown.status !== 200) throw unanswered(app, shown.status);
          return compareWithStandard(shown.json).differing.length === 0;
        },
      };
    },

    change(request, at, progress) {
      const app = pool().held;
      if (app === null) throw new VerifyFailure('NOT_READY', 'this worktree holds no application to change', '{cli} up');
      return change(app, request, at, progress);
    },

    changeMinimumVersion(request, at, progress) {
      const app = pool().held;
      if (app === null) throw new VerifyFailure('NOT_READY', 'this worktree holds no application to change', '{cli} up');
      return changeMinimumVersion(app, request, at, progress);
    },

    async restore(progress) {
      const app = pool().held;
      return app === null ? [] : restore(app, progress);
    },

    async liveConfig(prefixes) {
      const app = pool().held;
      if (app === null) throw new VerifyFailure('NOT_READY', 'this worktree holds no application', '{cli} up');
      const state = readState(workspace, app.entry.name);
      const open = await platform.open();
      const config = configLeaves(await open.readConfig(refOf(app), [...new Set(prefixes.map((prefix) => prefix.split('.')[0]!))]));
      const wanted = (leaf: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => leaf === prefix || leaf.startsWith(`${prefix}.`));
      return {
        application: { id: app.record.application, name: app.entry.name },
        pending: state.known ? (state.pending === null ? [] : pendingNames(state.pending)) : null,
        config: Object.fromEntries(Object.entries(config).filter(([leaf]) => wanted(leaf)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      };
    },

    stopDriving() {
      const app = pool().held;
      if (app === null) return;
      const current = readState(workspace, app.entry.name);
      if (current.drivers.some((driver) => driver.pid === self.pid)) writeState(workspace, app.entry.name, { ...current, drivers: otherDrivers(current) });
    },

    async finish(ledger, progress) {
      const owned = openApplications(ledger);
      if (owned.length === 0) return [];
      const open = await platform.open();
      const foreign = owned.filter((entry) => entry.workspace !== open.workspace);
      const mine = owned.filter((entry) => entry.workspace === open.workspace);
      const listed = await listing(open);
      const byName = new Map(listed.applications.map((application) => [application.name, application]));
      const targets = mine.flatMap((entry) => {
        const id = readRecord(ledger, entry.name)?.application;
        return byName.get(entry.name) ?? (id === undefined ? [] : [throwawayApplication(id, entry.name)]);
      });
      const deletions = await Promise.allSettled(targets.map((application) => open.delete(application)));
      const after = await open.list();
      const remaining = new Set(after.applications.map((application) => application.name));
      const gone = mine.filter((entry) => !remaining.has(entry.name));
      for (const entry of gone) close(ledger, entry);
      await reap(open, after, progress);

      const left = [...mine.filter((entry) => remaining.has(entry.name)), ...foreign];
      if (left.length > 0) {
        const refusal = deletions.find((result) => result.status === 'rejected');
        const why = foreign.length > 0 ? `${foreign.map((entry) => entry.name).join(', ')} belong to workspace ${foreign[0]!.workspace}, which this credential does not reach` : refusal === undefined ? 'Clerk still lists them' : (refusal.reason as Error).message;
        const one = foreign.length === 1;
        const fixes = [
          ...(left.length > foreign.length ? ['{cli} down again; it deletes what is left'] : []),
          ...(foreign.length === 0 ? [] : [`${foreign.map((entry) => entry.name).join(', ')} ${one ? 'belongs' : 'belong'} to workspace ${foreign[0]!.workspace}, which this credential cannot reach; only a credential of that workspace can delete ${one ? 'it' : 'them'}`]),
        ];
        throw new VerifyFailure('NOT_READY', `${count(left.length, 'application')} of this worktree could not be deleted: ${why}`, fixes.join('. '));
      }
      return gone.map((entry) => ({ name: entry.name }));
    },
  };
}
