import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    startE2ESharedRenderer,
    readE2ESharedRendererConfig,
} from '@scripts/electron-run/electronRunE2ESharedRenderer';
import {
    getCurrentSessionName,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    getNuxtPort,
    setNuxtPort,
} from '@scripts/electron-run/electronRunPortConfig';

const mocks = vi.hoisted(() => ({
    startNuxtServer: vi.fn(),
    isProcessAlive: vi.fn(() => true),
    killProcessTree: vi.fn(async () => undefined),
}));
vi.mock('@scripts/electron-run/electronRunNuxtServer', () => ({startNuxtServer: mocks.startNuxtServer}));
vi.mock('@scripts/electron-run/electronRunProcessTree', () => ({
    isProcessAlive: mocks.isProcessAlive,
    killProcessTree: mocks.killProcessTree,
}));

const originalSession = getCurrentSessionName();
const originalPort = getNuxtPort();
afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    setCurrentSessionName(originalSession);
    setNuxtPort(originalPort);
});

describe('shared renderer lifecycle', () => {
    function prepareEnvironment() {
        vi.stubEnv('EVB_E2E_RUN_ID', 'stress-lifecycle');
        vi.stubEnv('EVB_E2E_STRICT_ISOLATION', undefined);
        vi.stubEnv('EVB_NUXT_WARMUP_REQUIRED', undefined);
        vi.stubEnv('EVB_E2E_SHARED_RENDERER', undefined);
        vi.stubEnv('EVB_E2E_SHARED_RENDERER_PORT', undefined);
        setCurrentSessionName('existing-session');
    }

    it('reuses one isolated server for fresh scenario processes and stops only its owned process', async () => {
        prepareEnvironment();
        mocks.startNuxtServer.mockImplementation(async () => {
            expect(getCurrentSessionName()).toBe('e2e-stress-lifecycle-shared-renderer');
            expect(process.env.EVB_E2E_STRICT_ISOLATION).toBe('1');
            setNuxtPort(43210);
            return {pid: 321};
        });

        const renderer = await startE2ESharedRenderer();
        expect(getCurrentSessionName()).toBe('existing-session');
        expect(readE2ESharedRendererConfig()).toEqual({port: 43210});
        expect(mocks.startNuxtServer).toHaveBeenCalledOnce();
        expect(mocks.startNuxtServer).toHaveBeenCalledWith(false);
        const stop = renderer.stop();
        expect(renderer.stop()).toBe(stop);
        await stop;

        expect(mocks.killProcessTree).toHaveBeenCalledExactlyOnceWith(321, 1200);
        expect(readE2ESharedRendererConfig()).toBeNull();
        expect(process.env.EVB_E2E_STRICT_ISOLATION).toBeUndefined();
        expect(getNuxtPort()).toBe(originalPort);
    });

    it('restores the caller state after startup rejects', async () => {
        prepareEnvironment();
        mocks.startNuxtServer.mockRejectedValue(new Error('build failed'));
        await expect(startE2ESharedRenderer()).rejects.toThrow('build failed');
        expect(getCurrentSessionName()).toBe('existing-session');
        expect(readE2ESharedRendererConfig()).toBeNull();
        expect(process.env.EVB_E2E_STRICT_ISOLATION).toBeUndefined();
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
    });
});
