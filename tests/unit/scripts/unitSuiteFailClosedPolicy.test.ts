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
const UNIT_PROJECT_NAME = 'unit-scripts';
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

// Runs a throwaway vitest suite under the repository's own unit project
// configuration so the policy is checked against the real runner and setup
// file rather than a re-implementation.
function runProbeSuite(files: Record<string, string>) {
    const root = mkdtempSync(join(REPO_ROOT, '.devkit', 'tmp', 'unit-fail-closed-'));
    try {
        writeFileSync(join(root, 'vitest.config.mts'), [
            'import {defineConfig} from \'vitest/config\';',
            `import {vitestProjects} from ${JSON.stringify(join(REPO_ROOT, 'vitest.shared.config'))};`,
            `const unitProject = vitestProjects.find(project => project.test.name === ${JSON.stringify(UNIT_PROJECT_NAME)});`,
            'if (!unitProject) {',
            `    throw new Error('Missing unit project ${UNIT_PROJECT_NAME}');`,
            '}',
            'export default defineConfig({',
            '    ...unitProject,',
            '    test: {',
            '        ...unitProject.test,',
            '        include: [\'*.probe.test.ts\'],',
            '        exclude: [],',
            `        setupFiles: unitProject.test.setupFiles.map(file => ${JSON.stringify(`${REPO_ROOT}/`)} + file),`,
            '    },',
            '});',
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
            '--reporter',
            'default',
            `--outputFile.json=${outputFile}`,
        ], {
            cwd: root,
            encoding: 'utf8',
            env: childEnv,
            timeout: 120_000,
        });
        const parsed: unknown = JSON.parse(readFileSync(outputFile, 'utf8'));
        if (!isJsonReporterOutput(parsed)) {
            throw new Error(`Unexpected vitest JSON reporter output: ${run.stdout}\n${run.stderr}`);
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
            output: `${run.stdout}\n${run.stderr}`,
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

        expect(run.statuses.get('passes quietly'), run.output).toBe('passed');
        expect(run.statuses.get('passes while logging an unexpected error')).toBe('failed');
        expect(run.output).toMatch(/unhandled (?:error|rejection)/iu);
        expect(run.success).toBe(false);
        expect(run.exitCode).not.toBe(0);
    }, 120_000);
});
