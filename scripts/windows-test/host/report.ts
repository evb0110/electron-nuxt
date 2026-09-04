import {
    readFile,
    readdir,
} from 'node:fs/promises';
import {
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_SCHEMA_VERSION,
    isWindowsTestRunId,
    windowsTestExitCodes,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestRunSummary,
    TWindowsTestExitCode,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import { windowsTestRunLayout } from '@scripts/windows-test/contracts/windowsTestPaths';

const SUMMARY_STRING_FIELDS = [
    'suite',
    'environment',
    'sourceSha',
    'artifactSha256',
    'artifactFileName',
    'imageId',
    'vmId',
    'runnerVersion',
    'outcome',
    'startedAt',
    'endedAt',
    'evidenceDirectory',
] as const;

const SUMMARY_STRING_LIST_FIELDS = [
    'expectedTests',
    'executedTests',
    'passedTests',
    'failedTests',
    'unsupportedTests',
    'uncoveredObligations',
] as const;

export function isWindowsTestRunSummary(value: unknown): value is IWindowsTestRunSummary {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && isWindowsTestRunId(value.runId)
        && SUMMARY_STRING_FIELDS.every(field => typeof value[field] === 'string')
        && SUMMARY_STRING_LIST_FIELDS.every(field => isStringArray(value[field]))
        && typeof value.exitCode === 'number'
        && typeof value.humanReviewRequired === 'boolean'
        && typeof value.retainedClone === 'boolean'
        && Array.isArray(value.transitions)
        && value.transitions.every(isRecord)
        && Array.isArray(value.failures)
        && value.failures.every(isRecord);
}

export async function listWindowsTestRunIds(runsDir: string) {
    const entries = await readdir(runsDir, {withFileTypes: true}).catch(() => []);
    return entries
        .filter(entry => entry.isDirectory() && isWindowsTestRunId(entry.name))
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

export async function loadWindowsTestRunSummary(runsDir: string, runId: string) {
    const layout = windowsTestRunLayout(runsDir, runId);
    const raw = await readFile(layout.summaryFile, 'utf8').catch(() => null);
    if (raw === null) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    return isWindowsTestRunSummary(parsed) ? parsed : null;
}

export function formatWindowsTestRunSummary(summary: IWindowsTestRunSummary) {
    const lines = [
        `Run ${summary.runId} (${summary.suite} suite, environment ${summary.environment})`,
        `Artifact ${summary.artifactFileName} sha256 ${summary.artifactSha256} from source ${summary.sourceSha}`,
        `Image ${summary.imageId} on VM ${summary.vmId}, runner ${summary.runnerVersion}`,
        `Outcome ${summary.outcome} (exit code ${summary.exitCode})`,
        `Passed ${summary.passedTests.length}, failed ${summary.failedTests.length}, unsupported ${summary.unsupportedTests.length}, expected ${summary.expectedTests.length}`,
    ];
    if (summary.failedTests.length > 0) {
        lines.push(`Failed cases: ${summary.failedTests.join(', ')}`);
    }
    if (summary.unsupportedTests.length > 0) {
        lines.push(`Unsupported cases: ${summary.unsupportedTests.join(', ')}`);
    }
    // Uncovered obligations are printed on their own line and are never folded
    // into the passed count (invariant I8).
    lines.push(summary.uncoveredObligations.length === 0
        ? 'Uncovered obligations: none'
        : `Uncovered obligations (${summary.uncoveredObligations.length}): ${summary.uncoveredObligations.join(', ')}`);
    lines.push(`Human review obligation: ${summary.humanReviewRequired ? 'yes' : 'no'}`);
    for (const failure of summary.failures) {
        lines.push(`Failure in ${failure.phase} (${failure.outcome}): ${failure.reason}`);
    }
    lines.push(`Evidence directory: ${summary.evidenceDirectory}`);
    lines.push(`Retained clone: ${summary.retainedClone ? 'yes' : 'no'}`);
    return lines;
}

export interface IWindowsTestReportRequest {
    runsDir: string;
    runId: string | null;
    json: boolean;
}

export interface IWindowsTestReportResult {
    exitCode: TWindowsTestExitCode;
    summary: IWindowsTestRunSummary | null;
    lines: string[];
}

export async function buildWindowsTestReport(
    request: IWindowsTestReportRequest,
): Promise<IWindowsTestReportResult> {
    const runIds = await listWindowsTestRunIds(request.runsDir);
    const runId = request.runId ?? runIds.at(-1) ?? null;
    if (runId === null) {
        return {
            exitCode: windowsTestExitCodes.usageOrCrash,
            summary: null,
            lines: [`No Windows test runs are recorded under ${request.runsDir}.`],
        };
    }
    if (!isWindowsTestRunId(runId)) {
        return {
            exitCode: windowsTestExitCodes.usageOrCrash,
            summary: null,
            lines: [`"${runId}" is not a Windows test run ID; expected YYYYMMDDTHHMMSSZ-<12 hex>.`],
        };
    }
    const summary = await loadWindowsTestRunSummary(request.runsDir, runId);
    if (summary === null) {
        return {
            exitCode: windowsTestExitCodes.usageOrCrash,
            summary: null,
            lines: [`Run ${runId} has no readable summary.json under ${request.runsDir}.`],
        };
    }
    return {
        exitCode: windowsTestExitCodes.passed,
        summary,
        lines: request.json
            ? [JSON.stringify(summary, null, 4)]
            : formatWindowsTestRunSummary(summary),
    };
}
