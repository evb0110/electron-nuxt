import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createInterface: vi.fn(),
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async () => {}),
    verifyNativeToolProtocol: vi.fn(async () => {}),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('readline', () => ({createInterface: mocks.createInterface}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({verifyNativeToolProtocol: mocks.verifyNativeToolProtocol}));

class MockSidecarProcess extends EventEmitter {
    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();
}

class MockLineReader extends EventEmitter {
    readonly close = vi.fn();
}

function progressLine() {
    return JSON.stringify({
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
    });
}

describe('scan cleanup sidecar protocol failures', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
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
            progressLine(),
            new Error('Progress consumer failed'),
        ],
    ] as const)('closes stdout and terminates immediately on %s', async (
        _label,
        line,
        progressError,
    ) => {
        const child = new MockSidecarProcess();
        const lines = new MockLineReader();
        mocks.spawn.mockReturnValue(child);
        mocks.createInterface.mockReturnValue(lines);
        const {runScanCleanupSidecar} = await import(
            '@electron/features/scan-cleanup/worker/runScanCleanupSidecar'
        );
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/manifest.json',
            new AbortController().signal,
            vi.fn(),
            () => {
                if (progressError !== undefined) throw progressError;
            },
        );

        await vi.waitFor(() => expect(mocks.createInterface).toHaveBeenCalledOnce());
        lines.emit('line', line);
        await vi.waitFor(() => {
            expect(lines.close).toHaveBeenCalledOnce();
            expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
        });
        child.emit('exit', null, 'SIGTERM');

        if (progressError === undefined) {
            await expect(run).rejects.toBeInstanceOf(Error);
        } else {
            await expect(run).rejects.toBe(progressError);
        }
    });
});
