import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createInterface: vi.fn(),
    spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({spawn: mocks.spawn}));
vi.mock('node:readline', () => ({createInterface: mocks.createInterface}));

class MockCliSidecarProcess extends EventEmitter {
    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();

    readonly pid = 42_424;

    exitCode: number | null = null;

    signalCode: NodeJS.Signals | null = null;

    readonly kill = vi.fn();
}

class MockLineReader extends EventEmitter {
    readonly close = vi.fn();
}

describe('CLI scan cleanup sidecar protocol failures', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        [
            'malformed NDJSON',
            '{',
            undefined,
        ],
        [
            'schema-invalid NDJSON',
            JSON.stringify({
                version: 3,
                type: 'progress',
                progress: {},
            }),
            undefined,
        ],
        [
            'progress callback failure',
            JSON.stringify({
                version: 3,
                type: 'progress',
                progress: {
                    stage: 'page-complete',
                    completedPages: 1,
                    totalPages: 1,
                    pageNumber: 1,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                },
            }),
            new Error('CLI progress consumer failed'),
        ],
    ] as const)('closes stdout and terminates the process group on %s', async (
        _label,
        line,
        progressError,
    ) => {
        const child = new MockCliSidecarProcess();
        const lines = new MockLineReader();
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        mocks.spawn.mockReturnValue(child);
        mocks.createInterface.mockReturnValue(lines);
        const {runCliScanCleanupSidecar} = await import('@scripts/scanCleanupCliAdapters');
        const run = runCliScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/manifest.json',
            new AbortController().signal,
            vi.fn(),
            () => {
                if (progressError !== undefined) throw progressError;
            },
        );

        lines.emit('line', line);

        expect(lines.close).toHaveBeenCalledOnce();
        expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
        child.exitCode = 1;
        child.emit('exit', null, 'SIGTERM');
        if (progressError === undefined) {
            await expect(run).rejects.toBeInstanceOf(Error);
        } else {
            await expect(run).rejects.toBe(progressError);
        }
    });
});
