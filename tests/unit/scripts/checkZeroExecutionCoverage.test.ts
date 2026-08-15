import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    checkZeroExecutionCoverage,
    collectZeroExecutionTripwireTargets,
    formatZeroExecutionCoverageResult,
    isZeroExecutionTripwireTarget,
    parseLineCoverageSummary,
    runZeroExecutionCoverage,
} from '@scripts/checkZeroExecutionCoverage';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        force: true,
        recursive: true,
    })));
});

function fileSummary(total: number, covered: number) {
    return {lines: {
        total,
        covered,
        skipped: 0,
        pct: total === 0 ? 100 : covered / total * 100,
    }};
}

describe('zero-execution coverage tripwire', () => {
    it('targets high-risk IPC contracts and worker entrypoints', () => {
        expect(isZeroExecutionTripwireTarget('electron/platform-ipc/validatedIpcRegistrar.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('packages/contracts/agent.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('app/platform/browserSearch.worker.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('electron/search/worker.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('electron/ocr/worker/main.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget(
            'app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState.ts',
        )).toBe(true);
        expect(isZeroExecutionTripwireTarget(
            'app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts',
        )).toBe(true);
        expect(isZeroExecutionTripwireTarget('scan-cleanup-core/runScanCleanupConversion.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('scan-cleanup-adapters/createScanCleanupRenderers.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('electron/search/nativeSearch.ts')).toBe(false);
        expect(isZeroExecutionTripwireTarget('packages/contracts/types.d.ts')).toBe(false);
    });

    it('fails on missing report entries and executable files with no executed lines', () => {
        const projectRoot = '/repo';
        const coverage = parseLineCoverageSummary(JSON.stringify({
            total: fileSummary(10, 4),
            '/repo/electron/platform-ipc/a.ts': fileSummary(4, 0),
            '/repo/packages/contracts/typeOnly.ts': fileSummary(0, 0),
        }), projectRoot);
        const result = checkZeroExecutionCoverage([
            'electron/platform-ipc/a.ts',
            'packages/contracts/missing.ts',
            'packages/contracts/typeOnly.ts',
        ], coverage);

        expect(result).toEqual({
            missingFiles: ['packages/contracts/missing.ts'],
            passed: false,
            targetFileCount: 3,
            zeroExecutionFiles: ['electron/platform-ipc/a.ts'],
        });
        expect(formatZeroExecutionCoverageResult(result)).toContain('Files missing from the coverage report');
        expect(formatZeroExecutionCoverageResult(result)).toContain('Production files with zero executed lines');
    });

    it('rejects malformed line summaries at each input boundary', () => {
        expect(() => parseLineCoverageSummary('null')).toThrow('Coverage summary must be a JSON object.');
        expect(() => parseLineCoverageSummary('{"/repo/file.ts":null}', '/repo')).toThrow(
            'Coverage summary /repo/file.ts.lines must be an object.',
        );
        expect(() => parseLineCoverageSummary(JSON.stringify({'/repo/file.ts': {lines: {
            covered: 'invalid',
            total: 1,
        }}}), '/repo')).toThrow('Coverage summary /repo/file.ts.lines.covered must be a finite number.');
    });

    it('passes when every executable target has at least one executed line', () => {
        const coverage = new Map([
            [
                'electron/platform-ipc/a.ts',
                {
                    total: 4,
                    covered: 1,
                },
            ],
            [
                'packages/contracts/typeOnly.ts',
                {
                    total: 0,
                    covered: 0,
                },
            ],
        ]);
        const result = checkZeroExecutionCoverage([...coverage.keys()], coverage);

        expect(result.passed).toBe(true);
        expect(formatZeroExecutionCoverageResult(result)).toBe(
            'Zero-execution coverage tripwire passed for 2 production files.',
        );
    });

    it('discovers and checks targets across the widened production roots', async () => {
        const projectRoot = await mkdtemp(path.join(tmpdir(), 'evb-zero-execution-'));
        temporaryDirectories.push(projectRoot);
        const targetFiles = [
            'app/platform/search.worker.ts',
            'electron/platform-ipc/nested/registrar.ts',
            'packages/contracts/messages.ts',
            'scan-cleanup-adapters/createRenderers.ts',
            'scan-cleanup-core/nested/runCleanup.ts',
        ];
        await Promise.all([
            ...targetFiles,
            'app/platform/ignored.js',
            'packages/contracts/types.d.ts',
        ].map(async (relativePath) => {
            await mkdir(path.dirname(path.join(projectRoot, relativePath)), {recursive: true});
            await writeFile(path.join(projectRoot, relativePath), 'export const value = true;', 'utf8');
        }));
        const summaryPath = path.join(projectRoot, 'summary.json');
        await writeFile(summaryPath, JSON.stringify({
            total: fileSummary(targetFiles.length, targetFiles.length),
            ...Object.fromEntries(targetFiles.map(filePath => [
                path.join(projectRoot, filePath),
                fileSummary(1, 1),
            ])),
        }), 'utf8');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        expect(await collectZeroExecutionTripwireTargets(projectRoot)).toEqual(targetFiles);
        const result = await runZeroExecutionCoverage({
            projectRoot,
            summaryPath,
        });

        expect(result).toMatchObject({
            missingFiles: [],
            passed: true,
            targetFileCount: targetFiles.length,
            zeroExecutionFiles: [],
        });
        expect(consoleLog).toHaveBeenCalledWith(
            `Zero-execution coverage tripwire passed for ${targetFiles.length} production files.`,
        );
    });

    it('marks a failed filesystem-backed tripwire run for process failure', async () => {
        const projectRoot = await mkdtemp(path.join(tmpdir(), 'evb-zero-execution-failure-'));
        temporaryDirectories.push(projectRoot);
        await Promise.all([
            'app/platform',
            'electron',
            'packages',
            'scan-cleanup-adapters',
            'scan-cleanup-core',
        ].map(directory => mkdir(path.join(projectRoot, directory), {recursive: true})));
        await writeFile(
            path.join(projectRoot, 'app/platform/search.worker.ts'),
            'export const value = true;',
            'utf8',
        );
        const summaryPath = path.join(projectRoot, 'summary.json');
        await writeFile(summaryPath, JSON.stringify({total: fileSummary(0, 0)}), 'utf8');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const originalExitCode = process.exitCode;

        try {
            const result = await runZeroExecutionCoverage({
                projectRoot,
                summaryPath,
            });

            expect(result.passed).toBe(false);
            expect(result.missingFiles).toEqual(['app/platform/search.worker.ts']);
            expect(process.exitCode).toBe(1);
        } finally {
            process.exitCode = originalExitCode;
        }
    });
});
