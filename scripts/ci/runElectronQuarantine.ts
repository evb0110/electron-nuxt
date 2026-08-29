import {spawn} from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import os from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface IQuarantineSummary {
    failed: number;
    passed: number;
    pending: number;
    todo: number;
    total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

const QUARANTINE_COUNTER_KEYS = [
    'numFailedTests',
    'numPassedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTests',
] as const;

type TQuarantineCounterKey = typeof QUARANTINE_COUNTER_KEYS[number];

const COUNTER_TO_SUMMARY_KEY: Record<TQuarantineCounterKey, keyof IQuarantineSummary> = {
    numFailedTests: 'failed',
    numPassedTests: 'passed',
    numPendingTests: 'pending',
    numTodoTests: 'todo',
    numTotalTests: 'total',
};

function readCounters(report: Record<string, unknown>) {
    return Object.fromEntries(QUARANTINE_COUNTER_KEYS.map(key => {
        const value = report[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
            throw new Error(`invalid quarantine counter ${key}: ${String(value)}`);
        }
        return [
            key,
            value as number | undefined,
        ];
    })) as Record<TQuarantineCounterKey, number | undefined>;
}

function countNestedAssertions(report: Record<string, unknown>) {
    const rawSuites = report.testResults;
    if (rawSuites === undefined) {
        return null;
    }
    if (!Array.isArray(rawSuites)) {
        throw new Error('Quarantine report testResults must be an array');
    }
    const statuses = rawSuites.flatMap((rawSuite, suiteIndex) => {
        if (!isRecord(rawSuite)) {
            throw new Error(`Quarantine report suite ${suiteIndex} must be an object`);
        }
        const rawAssertions = rawSuite.assertionResults;
        if (rawAssertions === undefined) {
            return [];
        }
        if (!Array.isArray(rawAssertions)) {
            throw new Error(`Quarantine report suite ${suiteIndex} assertionResults must be an array`);
        }
        return rawAssertions.map((rawAssertion, assertionIndex) => {
            if (!isRecord(rawAssertion) || typeof rawAssertion.status !== 'string') {
                throw new Error(
                    `Quarantine report assertion ${suiteIndex}:${assertionIndex} has no valid status`,
                );
            }
            if (![
                'failed',
                'passed',
                'pending',
                'skipped',
                'todo',
            ].includes(rawAssertion.status)) {
                throw new Error(
                    `Quarantine report assertion ${suiteIndex}:${assertionIndex} has unknown status `
                    + `'${rawAssertion.status}'`,
                );
            }
            return rawAssertion.status;
        });
    });
    return {
        failed: statuses.filter(status => status === 'failed').length,
        passed: statuses.filter(status => status === 'passed').length,
        pending: statuses.filter(status => status === 'pending' || status === 'skipped').length,
        todo: statuses.filter(status => status === 'todo').length,
        total: statuses.length,
    };
}

export function summarizeQuarantineReport(report: unknown): IQuarantineSummary {
    if (!isRecord(report)) {
        throw new Error('Quarantine JSON reporter output must be an object');
    }
    if (report.success !== undefined && typeof report.success !== 'boolean') {
        throw new Error(`Quarantine report success must be boolean: ${String(report.success)}`);
    }
    const counters = readCounters(report);
    const nested = countNestedAssertions(report);
    if (nested !== null && nested.total === 0) {
        throw new Error('empty quarantine assertions cannot be admitted');
    }
    const hasNestedAssertions = nested !== null && nested.total > 0;
    if (hasNestedAssertions) {
        for (const key of QUARANTINE_COUNTER_KEYS) {
            const topLevel = counters[key];
            const nestedKey = COUNTER_TO_SUMMARY_KEY[key];
            if (topLevel !== undefined && topLevel !== nested[nestedKey]) {
                throw new Error(
                    `Quarantine report counter mismatch for ${key}: `
                    + `top-level ${topLevel}, nested ${nested[nestedKey]}`,
                );
            }
        }
        return nested;
    }

    const total = counters.numTotalTests;
    if (total === undefined) {
        if (QUARANTINE_COUNTER_KEYS.some(key => key !== 'numTotalTests' && counters[key] !== undefined)) {
            throw new Error('Quarantine report counter mismatch: numTotalTests is missing');
        }
        return {
            failed: 0,
            passed: 0,
            pending: 0,
            todo: 0,
            total: 0,
        };
    }
    const summary = {
        failed: counters.numFailedTests ?? 0,
        passed: counters.numPassedTests ?? 0,
        pending: counters.numPendingTests ?? 0,
        todo: counters.numTodoTests ?? 0,
        total,
    };
    const categoryTotal = summary.failed + summary.passed + summary.pending + summary.todo;
    if (categoryTotal !== total) {
        throw new Error(
            `Quarantine report counter mismatch: top-level total ${total}, `
            + `categories ${categoryTotal}`,
        );
    }
    return {...summary};
}

export function assertQuarantineReport(report: unknown): IQuarantineSummary {
    if (isRecord(report) && report.success === false) {
        throw new Error('Electron quarantine reporter marked the run as failed');
    }
    const summary = summarizeQuarantineReport(report);
    if (summary.total === 0) {
        throw new Error('Electron quarantine run collected zero tests');
    }
    if (summary.failed > 0) {
        throw new Error(`Electron quarantine run has ${summary.failed} failed tests`);
    }
    if (summary.pending > 0 || summary.todo > 0) {
        throw new Error(
            `Electron quarantine run has skipped or pending tests (pending=${summary.pending}, todo=${summary.todo})`,
        );
    }
    if (summary.passed !== summary.total) {
        throw new Error(
            `Electron quarantine run did not execute every test (passed=${summary.passed}, total=${summary.total})`,
        );
    }
    return summary;
}

type TSpawn = typeof spawn;

export async function runElectronQuarantine({
    cwd = process.cwd(),
    runner = 'scripts/test-electron-e2e-headless.sh',
    spawnImpl = spawn,
}: {
    cwd?: string;
    runner?: string;
    spawnImpl?: TSpawn;
} = {}) {
    const reportRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'evb-quarantine-'));
    const reportPath = join(reportRoot, 'vitest-report.json');
    const args = [
        runner,
        '--no-build',
        'e2e-quarantine',
        '--reporter',
        'json',
        `--outputFile.json=${reportPath}`,
    ];
    try {
        const exitCode = await new Promise<number>((resolvePromise, reject) => {
            const child = spawnImpl('bash', args, {
                cwd,
                env: process.env,
                stdio: 'inherit',
            });
            child.once('error', reject);
            child.once('exit', (code, signal) => {
                if (signal) {
                    resolvePromise(1);
                    return;
                }
                resolvePromise(code ?? 1);
            });
        });
        if (exitCode !== 0) {
            throw new Error(`Electron quarantine runner exited with status ${exitCode}`);
        }
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
        const summary = assertQuarantineReport(report);
        process.stdout.write(`Electron quarantine passed: ${JSON.stringify(summary)}\n`);
        return summary;
    } finally {
        await rm(reportRoot, {
            force: true,
            recursive: true,
        });
    }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    runElectronQuarantine().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
