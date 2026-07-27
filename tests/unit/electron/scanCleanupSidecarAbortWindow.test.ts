import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TWorkerLog } from '@electron/ocr/worker/types';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async () => {}),
    verifyNativeToolProtocol: vi.fn(async () => {}),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({verifyNativeToolProtocol: mocks.verifyNativeToolProtocol}));

class MockSidecarProcess extends EventEmitter {
    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();

    readonly kill = vi.fn();
}

describe('scan cleanup sidecar abort window', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // Native command admission resolves its waiters synchronously, so a run
    // that is canceled in the same tick as the release that admitted it reaches
    // the spawn with an already-aborted signal. The listener the sidecar
    // attaches after the spawn never replays that abort, so the terminate has
    // to be re-checked once the process exists.
    it('terminates a sidecar whose run was canceled while it waited for a native command slot', async () => {
        vi.stubEnv('EVB_NATIVE_COMMAND_MAX_CONCURRENCY', '1');
        vi.resetModules();
        const { acquireNativeCommandAdmission } = await import('@electron/native-tools/runNativeCommand');
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const releaseOccupant = await acquireNativeCommandAdmission();
        const controller = new AbortController();

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/canceled-manifest.json',
            controller.signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await new Promise(resolve => {
                setImmediate(resolve);
            });
        }
        expect(mocks.spawn).not.toHaveBeenCalled();

        releaseOccupant();
        controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());

        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
        child.emit('exit', null, 'SIGKILL');
        await expect(run).rejects.toMatchObject({name: 'AbortError'});
    });
});
