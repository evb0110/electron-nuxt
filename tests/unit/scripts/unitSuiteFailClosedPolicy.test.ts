import {spawnSync} from 'node:child_process';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const REPO_ROOT = process.cwd();
const UNIT_SETUP_FILE = join(REPO_ROOT, 'tests', 'setup.ts');
const VITEST_ENTRY = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

interface IJsonReporterOutput {
    success: boolean;
    testResults: Array<{assertionResults: Array<{
        title: string;
        status: string
    }>}>;
}

function isJsonReporterOutput(value: unknown): value is IJsonReporterOutput {
    return typeof value === 'object'
        && value !== null
        && 'success' in value
        && Array.isArray((value as {testResults?: unknown}).testResults);
}

// Runs a throwaway vitest suite under the repository's unit setup file so the
// policy is checked against the real runner rather than a re-implementation.
function runProbeSuite(files: Record<string, string>) {
    const root = mkdtempSync(join(REPO_ROOT, '.devkit', 'tmp', 'unit-fail-closed-'));
    try {
        writeFileSync(join(root, 'vitest.config.mts'), [
            'import {defineConfig} from \'vitest/config\';',
            'export default defineConfig({test: {',
            '    include: [\'*.probe.test.ts\'],',
            '    globals: false,',
            `    setupFiles: [${JSON.stringify(UNIT_SETUP_FILE)}],`,
            '}});',
            '',
        ].join('\n'));
        for (const [
            name,
            source,
        ] of Object.entries(files)) {
            writeFileSync(join(root, name), source);
        }
        const outputFile = join(root, 'results.json');
        const childEnv = Object.fromEntries(Object.entries(process.env)
            .filter(([key]) => !key.startsWith('VITEST')));
        const run = spawnSync(process.execPath, [
            VITEST_ENTRY,
            'run',
            '--root',
            root,
            '--config',
            join(root, 'vitest.config.mts'),
            '--reporter',
            'json',
            '--outputFile',
            outputFile,
        ], {
            cwd: root,
            encoding: 'utf8',
            env: childEnv,
            timeout: 120_000,
        });
        const parsed: unknown = JSON.parse(readFileSync(outputFile, 'utf8'));
        if (!isJsonReporterOutput(parsed)) {
            throw new Error(`Unexpected vitest JSON reporter output: ${run.stderr}`);
        }
        const statuses = new Map(parsed.testResults
            .flatMap(result => result.assertionResults)
            .map(result => [
                result.title,
                result.status,
            ] as const));
        return {
            exitCode: run.status,
            statuses,
            stderr: run.stderr,
            success: parsed.success,
        };
    } finally {
        rmSync(root, {
            force: true,
            recursive: true,
        });
    }
}

describe('unit suite fail-closed policy', () => {
    it('fails a test that logs a console error and fails the run on an unhandled rejection', () => {
        const run = runProbeSuite({
            'console.probe.test.ts': [
                'import {it} from \'vitest\';',
                'it(\'passes while logging an unexpected error\', () => {',
                '    console.error(\'unexpected failure path\');',
                '});',
                '',
            ].join('\n'),
            'unhandled.probe.test.ts': [
                'import {it} from \'vitest\';',
                'it(\'passes while leaving a rejection behind\', async () => {',
                '    void Promise.reject(new Error(\'late failure\'));',
                '    await new Promise(resolve => setTimeout(resolve, 20));',
                '});',
                '',
            ].join('\n'),
            'control.probe.test.ts': [
                'import {expect, it} from \'vitest\';',
                'it(\'passes quietly\', () => {',
                '    expect(1).toBe(1);',
                '});',
                '',
            ].join('\n'),
        });

        expect(run.statuses.get('passes quietly')).toBe('passed');
        expect(run.statuses.get('passes while logging an unexpected error')).toBe('failed');
        expect(run.stderr).toMatch(/unhandled (?:error|rejection)/iu);
        expect(run.success).toBe(false);
        expect(run.exitCode).not.toBe(0);
    }, 120_000);
});
