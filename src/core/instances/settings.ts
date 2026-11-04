import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MinimumVersionRequest, NativeAppPlatform, SettingLeaves, SettingsRequest } from '../../../specs/support/types.ts';
import { VerifyFailure, type Json } from '../types.ts';

export type Leaves = Readonly<Record<string, Json>>;

type JsonObject = { readonly [key: string]: Json };

export interface StandardFile {
  readonly config: JsonObject;
  readonly environment: Leaves;
}

export const STANDARD_FILE = 'src/core/instances/base.json';

const standard = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'base.json'), 'utf8')) as StandardFile;

export const standardFile = (): StandardFile => standard;

export interface LeafChange {
  readonly leaf: string;
  readonly from: Json;
  readonly to: Json;
}

export interface Snapshot {
  readonly config: Leaves;
  readonly sections: Leaves;
  readonly environment: Leaves;
  /** The platforms whose minimum app versions a test set. Their names hold dots, so they are not leaves, and a restore deletes them. */
  readonly minimumVersions?: readonly NativeAppPlatform[];
}

export class SettingsNotShown extends VerifyFailure {
  constructor(message: string, fix: string) {
    super('INSTANCE_MISCONFIGURED', message, fix);
  }
}

export class SettingsRefused extends VerifyFailure {
  readonly param: string | null;
  readonly said: string;
  constructor(message: string, fix: string, refusal: { readonly param: string | null; readonly said: string } = { param: null, said: message }) {
    super('INSTANCE_MISCONFIGURED', message, fix);
    this.param = refusal.param;
    this.said = refusal.said;
  }
}

const isObject = (value: Json | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export function flattenEnvironment(value: Json, path = '', out: Record<string, Json> = {}): Leaves {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== 'object' || item === null)) out[path] = value.map(String).sort();
    else value.forEach((item, index) => flattenEnvironment(item, `${path}[${index}]`, out));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) flattenEnvironment(child, path === '' ? key : `${path}.${key}`, out);
  } else {
    out[path] = value;
  }
  return out;
}

export interface EnvironmentDifference {
  readonly path: string;
  readonly expected: Json;
  readonly found: Json | undefined;
}

export interface EnvironmentComparison {
  readonly compared: number;
  readonly differing: readonly EnvironmentDifference[];
}

export const compareLeaves = (expected: Leaves, shown: Leaves): readonly EnvironmentDifference[] =>
  Object.entries(expected).flatMap(([path, want]): EnvironmentDifference[] => {
    const found = Object.hasOwn(shown, path) ? shown[path] : undefined;
    return JSON.stringify(found) === JSON.stringify(want) ? [] : [{ path, expected: want, found }];
  });

export function compareEnvironment(expected: Leaves, live: Json): EnvironmentComparison {
  return { compared: Object.keys(expected).length, differing: compareLeaves(expected, flattenEnvironment(live)) };
}

export const describeDifference = (d: EnvironmentDifference, expectedBy = 'the file says'): string => `${d.path} is ${d.found === undefined ? 'absent' : JSON.stringify(d.found)}, and ${expectedBy} ${JSON.stringify(d.expected)}`;

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function configLeaves(value: Json, path = '', out: Record<string, Json> = {}): Leaves {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) configLeaves(child, path === '' ? key : `${path}.${key}`, out);
  } else {
    out[path] = value;
  }
  return out;
}

const unordered = (value: Json): Json => (Array.isArray(value) ? value.map(canonical).sort() : value);

export const sameLeaf = (a: Json | undefined, b: Json | undefined): boolean => a !== undefined && b !== undefined && canonical(unordered(a)) === canonical(unordered(b));

const keyOf = (value: Json): string => createHash('sha256').update(canonical(value)).digest('hex').slice(0, 12);

export const BASE_KEY = keyOf({ config: standard.config, environment: standard.environment });

export function nest(leaves: Leaves): JsonObject {
  const root: Record<string, Json> = Object.create(null);
  for (const [leaf, value] of Object.entries(leaves)) {
    const path = leaf.split('.');
    let node = root;
    for (const key of path.slice(0, -1)) node = (node[key] ??= Object.create(null)) as Record<string, Json>;
    node[path.at(-1)!] = value;
  }
  return root;
}

export const underneath = (pending: Snapshot | null, more: Snapshot): Snapshot => {
  if (pending === null) return more;
  const minimumVersions = [...new Set([...(pending.minimumVersions ?? []), ...(more.minimumVersions ?? [])])];
  return {
    config: { ...more.config, ...pending.config },
    sections: { ...more.sections, ...pending.sections },
    environment: { ...more.environment, ...pending.environment },
    ...(minimumVersions.length === 0 ? {} : { minimumVersions }),
  };
};

const CONFIG_LEAF = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const ENVIRONMENT_LEAF = /^[A-Za-z0-9_]+(\[\d+\])*(\.[A-Za-z0-9_]+(\[\d+\])*)*$/;
const SPEC_SITE = /^specs\/\S+\.e2e\.ts:\d+$/;

const isScalar = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value);

function leavesOf(name: 'config' | 'environment', raw: unknown, pattern: RegExp): SettingLeaves | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${name} is not an object of dotted leaves and their values`;
  const leaves = Object.keys(raw);
  if (leaves.length === 0) return name === 'config' ? 'config names no leaf to change' : 'environment names no leaf; leave it out, and the CLI waits for any leaf of the environment to change';
  for (const [leaf, value] of Object.entries(raw)) {
    if (!pattern.test(leaf)) return `${name} has ${JSON.stringify(leaf)}, which is not a dotted leaf name`;
    if (!(isScalar(value) || (Array.isArray(value) && value.every(isScalar)))) return `${name} leaf ${leaf} holds an object; write each leaf by its full dotted path, as in "auth_multi_factor.required_for_sign_up": true`;
    const inside = leaves.find((other) => other.startsWith(`${leaf}.`));
    if (inside !== undefined) return `${name} names both ${leaf} and ${inside}, which is inside it`;
  }
  return raw as SettingLeaves;
}

export function parseSettingsRequest(body: Readonly<Record<string, unknown>>): { readonly request: SettingsRequest; readonly at: string | null } | { readonly refused: string } {
  const extra = Object.keys(body).filter((key) => !['config', 'environment', 'at'].includes(key));
  if (extra.length > 0) return { refused: `it carries ${extra.join(', ')}, and host.useSettings sends only config, environment, and at` };
  const config = leavesOf('config', body.config, CONFIG_LEAF);
  if (typeof config === 'string') return { refused: config };
  const environment = body.environment === undefined ? undefined : leavesOf('environment', body.environment, ENVIRONMENT_LEAF);
  if (typeof environment === 'string') return { refused: environment };
  const at = typeof body.at === 'string' && SPEC_SITE.test(body.at) ? body.at : null;
  return { request: { config, ...(environment === undefined ? {} : { environment }) }, at };
}

const NATIVE_APP_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;
const APP_VERSION = /^\d+(\.\d+){0,2}$/;

export const isNativeAppPlatform = (value: unknown): value is NativeAppPlatform => value === 'ios' || value === 'android';

export function parseMinimumVersionRequest(body: Readonly<Record<string, unknown>>): { readonly request: MinimumVersionRequest; readonly at: string | null } | { readonly refused: string } {
  const extra = Object.keys(body).filter((key) => !['app', 'minimumVersion', 'updateUrl', 'at'].includes(key));
  if (extra.length > 0) return { refused: `it carries ${extra.join(', ')}, and host.useMinimumAppVersion sends only app, minimumVersion, updateUrl, and at` };
  const { platform, id } = (body.app ?? {}) as { platform?: unknown; id?: unknown };
  if (!isNativeAppPlatform(platform)) return { refused: `app.platform is ${JSON.stringify(platform)}, not ios or android` };
  if (typeof id !== 'string' || !NATIVE_APP_ID.test(id)) return { refused: `app.id is ${JSON.stringify(id)}, not a bundle ID or a package name` };
  const { minimumVersion, updateUrl } = body;
  if (typeof minimumVersion !== 'string' || !APP_VERSION.test(minimumVersion)) return { refused: `minimumVersion is ${JSON.stringify(minimumVersion)}, not a version such as 2.0` };
  if (typeof updateUrl !== 'string' || !/^https?:\/\/\S+$/.test(updateUrl)) return { refused: `updateUrl is ${JSON.stringify(updateUrl)}, not an http or https URL` };
  const at = typeof body.at === 'string' && SPEC_SITE.test(body.at) ? body.at : null;
  return { request: { app: { platform, id }, minimumVersion, updateUrl }, at };
}
