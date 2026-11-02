import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export function compareEnvironment(expected: Leaves, live: Json): EnvironmentComparison {
  const shown = flattenEnvironment(live);
  const differing = Object.entries(expected).flatMap(([path, want]): EnvironmentDifference[] => {
    const found = Object.hasOwn(shown, path) ? shown[path] : undefined;
    return JSON.stringify(found) === JSON.stringify(want) ? [] : [{ path, expected: want, found }];
  });
  return { compared: Object.keys(expected).length, differing };
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
