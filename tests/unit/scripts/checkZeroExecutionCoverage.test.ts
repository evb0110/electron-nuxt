import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    checkZeroExecutionCoverage,
    formatZeroExecutionCoverageResult,
    isZeroExecutionTripwireTarget,
    parseLineCoverageSummary,
} from '@scripts/checkZeroExecutionCoverage';

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
});
