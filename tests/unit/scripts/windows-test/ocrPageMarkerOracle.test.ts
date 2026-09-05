import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    generateNumberedFixture,
    numberedFixtureMarkers,
} from '@scripts/windows-test/fixtures/generateNumberedFixture';
import {
    evaluateOcrPageMarkers,
    OcrRuntimeUnavailableError,
} from '@scripts/windows-test/oracles/ocrPageMarkerOracle';

const repositoryRoot = process.cwd();

function runnerFor(outputs: readonly string[], calls: Array<{
    args: readonly string[];
    timeoutMs: number
}>, resultOverrides: Partial<{
    exitCode: number | null;
    stderr: string;
    timedOut: boolean;
}> = {}) {
    let index = 0;
    return async (_command: string, args: readonly string[], _input: Uint8Array, timeoutMs: number) => {
        calls.push({
            args,
            timeoutMs,
        });
        return {
            exitCode: resultOverrides.exitCode ?? 0,
            stdout: `${outputs[index++] ?? ''}\n`,
            stderr: resultOverrides.stderr ?? '',
            timedOut: resultOverrides.timedOut ?? false,
        };
    };
}

describe('OCR page-marker oracle', () => {
    it('requires every exact marker in page order', async () => {
        const markers = numberedFixtureMarkers();
        const calls: Array<{
            args: readonly string[];
            timeoutMs: number
        }> = [];
        const result = await evaluateOcrPageMarkers(await generateNumberedFixture(), {
            repositoryRoot,
            expectedMarkers: markers,
            processRunner: runnerFor(markers, calls),
        });

        expect(result.status).toBe('passed');
        expect(calls).toHaveLength(markers.length);
        expect(calls[0]?.args).toEqual([
            'stdin',
            'stdout',
            '-l',
            'eng',
            '--psm',
            '6',
            '-c',
            'tessedit_char_whitelist=EVB-F0123456789PAGE',
        ]);
        expect(calls.every(call => call.timeoutMs === 30_000)).toBe(true);
    });

    it('rejects reordered and missing OCR markers', async () => {
        const markers = numberedFixtureMarkers();
        const reordered = [
            markers[1]!,
            markers[0]!,
            ...markers.slice(2),
        ];
        const reorderedResult = await evaluateOcrPageMarkers(await generateNumberedFixture(), {
            repositoryRoot,
            expectedMarkers: markers,
            processRunner: runnerFor(reordered, []),
        });
        expect(reorderedResult.status).toBe('failed');
        expect(reorderedResult.detail).toContain('page 1 OCR marker');

        const missing = markers.map((marker, index) => index === 5 ? '' : marker);
        const missingResult = await evaluateOcrPageMarkers(await generateNumberedFixture(), {
            repositoryRoot,
            expectedMarkers: markers,
            processRunner: runnerFor(missing, []),
        });
        expect(missingResult.status).toBe('failed');
        expect(missingResult.detail).toContain('page 6 OCR marker ""');
    }, 30_000);

    it('does not accept extra OCR text as an exact marker', async () => {
        const markers = numberedFixtureMarkers();
        const outputs = [...markers];
        outputs[0] = `${markers[0]} EXTRA`;
        const result = await evaluateOcrPageMarkers(await generateNumberedFixture(), {
            repositoryRoot,
            expectedMarkers: markers,
            processRunner: runnerFor(outputs, []),
        });

        expect(result.status).toBe('failed');
        expect(result.detail).toContain('does not exactly match');
    });

    it('reports a missing OCR runtime as inconclusive', async () => {
        const result = await evaluateOcrPageMarkers(await generateNumberedFixture(), {
            repositoryRoot,
            expectedMarkers: numberedFixtureMarkers(),
            processRunner: async () => {
                throw new OcrRuntimeUnavailableError('tesseract is unavailable');
            },
        });

        expect(result.status).toBe('inconclusive');
        expect(result.detail).toContain('tesseract is unavailable');
    });

    it('reports a non-zero OCR process as inconclusive with stderr', async () => {
        const result = await evaluateOcrPageMarkers(await generateNumberedFixture(), {
            repositoryRoot,
            expectedMarkers: numberedFixtureMarkers(),
            processRunner: runnerFor([], [], {
                exitCode: 7,
                stderr: 'tesseract failed',
            }),
        });

        expect(result.status).toBe('inconclusive');
        expect(result.detail).toContain('tesseract failed');
    });

    it('reports an OCR timeout as inconclusive', async () => {
        const result = await evaluateOcrPageMarkers(await generateNumberedFixture(), {
            repositoryRoot,
            expectedMarkers: numberedFixtureMarkers(),
            processRunner: runnerFor([], [], {
                timedOut: true,
                stderr: 'OCR timed out',
            }),
        });

        expect(result.status).toBe('inconclusive');
        expect(result.detail).toContain('OCR timed out');
    });
});
