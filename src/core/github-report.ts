import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FinishedRun, Report } from 'e2e';
import { github } from '@e2e-dev/github';
import { protect, redact } from '../../specs/support/secret.ts';
import type { EvidenceRecord, VerifyFailure } from './types.ts';

const POST_TIMEOUT_MS = 60_000;

export function protectGitHubTokens(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[name]?.trim();
    if (value) protect(value);
  }
}

type RunError = Report['run']['errors'][number];

export function withFailure(report: Report, failure: VerifyFailure | null): Report {
  if (failure === null) return report;
  const error: RunError = { category: 'infrastructure', code: failure.code, message: redact(failure.message), retryable: false };
  return {
    ...report,
    run: {
      ...report.run,
      status: report.run.status === 'passed' ? 'failed' : report.run.status,
      exitCode: report.run.exitCode === 0 ? 1 : report.run.exitCode,
      errors: [...report.run.errors, error],
    },
  };
}

export interface GitHubReportInput {
  readonly record: EvidenceRecord;
  readonly failure: VerifyFailure | null;
  readonly packageDir: string;
}

export async function reportToGitHub({ record, failure, packageDir }: GitHubReportInput): Promise<readonly string[]> {
  if (record.tainted.length > 0) return ['not reported: a file of this run holds a secret value'];
  try {
    if (!existsSync(record.e2eReport)) return ['not reported: e2e wrote no report for this run'];
    const report = withFailure(JSON.parse(readFileSync(record.e2eReport, 'utf8')) as Report, failure);
    const run: FinishedRun = {
      report,
      status: report.run.status,
      exitCode: report.run.exitCode,
      projectRoot: packageDir,
      reportPath: record.e2eReport,
      artifactsRoot: join(dirname(record.e2eReport), 'results'),
      aiTracePath: undefined,
      traces: new Map(),
    };
    const rows = await github({ key: record.platform }).onRunFinished!(run, AbortSignal.timeout(POST_TIMEOUT_MS));
    return (rows ?? []).map((row) => row.text);
  } catch (error) {
    return [redact(`not reported: ${(error as Error).message ?? String(error)}`)];
  }
}
