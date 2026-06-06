import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    class TestEmitter {
        private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

        on(event: string, handler: (...args: unknown[]) => void) {
            const handlers = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
            handlers.add(handler);
            this.listeners.set(event, handlers);
            return this;
        }

        emit(event: string, ...args: unknown[]) {
            for (const handler of this.listeners.get(event) ?? []) {
                handler(...args);
            }
            return this;
        }

        removeAllListeners() {
            this.listeners.clear();
            return this;
        }
    }

    const autoUpdater = new TestEmitter() as TestEmitter & {
        autoDownload: boolean;
        autoInstallOnAppQuit: boolean;
        checkForUpdates: ReturnType<typeof vi.fn>;
        quitAndInstall: ReturnType<typeof vi.fn>;
    };

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.checkForUpdates = vi.fn();
    autoUpdater.quitAndInstall = vi.fn();

    return {
        app: {
            getVersion: vi.fn(() => '1.0.0'),
            isPackaged: true,
        },
        autoUpdater,
        fetch: vi.fn(),
        loadSettings: vi.fn(async () => ({})),
        logger: {
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        },
        updateSettings: vi.fn(async (updater: (settings: Record<string, unknown>) => void) => {
            const settings: Record<string, unknown> = {};
            updater(settings);
            return settings;
        }),
    };
});

vi.mock('electron', () => ({app: mocks.app}));

vi.mock('electron-updater', () => ({default: {autoUpdater: mocks.autoUpdater}}));

vi.mock('@electron/config', () => ({config: {updates: {
    initialDelayMs: 1_000,
    metadataUrl: 'https://updates.example.test/latest',
    pollIntervalMs: 60_000,
}}}));

vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    updateSettings: mocks.updateSettings,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

const originalPlatform = process.platform;
const originalArch = process.arch;

function createMetadataResponse(version: string) {
    return {
        ok: true,
        status: 200,
        json: async () => ({release: {tag: version}}),
    };
}

function createEmptyResponse(status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({}),
    };
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

async function loadUpdatesModule() {
    vi.resetModules();
    return import('@electron/updates');
}

beforeAll(() => {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32',
    });
    Object.defineProperty(process, 'arch', {
        configurable: true,
        value: 'x64',
    });
});

describe('updates robustness', () => {
    beforeEach(() => {
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        Object.defineProperty(process, 'arch', {
            configurable: true,
            value: 'x64',
        });
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.autoUpdater.removeAllListeners();
        mocks.autoUpdater.checkForUpdates.mockReset();
        mocks.autoUpdater.quitAndInstall.mockReset();
        mocks.fetch.mockReset();
        mocks.loadSettings.mockReset();
        mocks.updateSettings.mockReset();
        mocks.app.getVersion.mockReturnValue('1.0.0');
        mocks.loadSettings.mockResolvedValue({});
        mocks.updateSettings.mockImplementation(async (updater: (settings: Record<string, unknown>) => void) => {
            const settings: Record<string, unknown> = {};
            updater(settings);
            return settings;
        });
        vi.stubGlobal('fetch', mocks.fetch);
    });

    afterEach(async () => {
        try {
            const updates = await import('@electron/updates');
            await updates.shutdownUpdates();
        } catch {
            // Ignore reset/import failures during teardown.
        }
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('returns automatic no-update checks to idle state', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await vi.advanceTimersByTimeAsync(1_000);
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(statuses.at(-1)).toMatchObject({
            origin: 'auto',
            phase: 'idle',
            version: '1.0.0',
        });
    });

    it('lets a manual check complete after waiting for an automatic check already in flight', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));

        let resolveAutoCheck: (() => void) | null = null;
        mocks.autoUpdater.checkForUpdates.mockImplementation(() => {
            const callNumber = mocks.autoUpdater.checkForUpdates.mock.calls.length;
            mocks.autoUpdater.emit('checking-for-update');

            if (callNumber === 1) {
                return new Promise<void>((resolve) => {
                    resolveAutoCheck = () => {
                        mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
                        resolve();
                    };
                });
            }

            mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
            return Promise.resolve();
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await vi.advanceTimersByTimeAsync(1_000);
        await flushPromises();

        const manualCheckPromise = updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'checking',
        });

        const completeAutoCheck = resolveAutoCheck as (() => void) | null;
        if (completeAutoCheck) {
            completeAutoCheck();
        }
        await manualCheckPromise;
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            version: '1.0.0',
        });
    });

    it('does not let an older downloaded update mask a newer release forever', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.2.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            const callNumber = mocks.autoUpdater.checkForUpdates.mock.calls.length;
            mocks.autoUpdater.emit('checking-for-update');

            if (callNumber === 1) {
                mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
                mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
                return;
            }

            mocks.autoUpdater.emit('update-available', { version: '1.2.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.2.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloaded',
            version: '1.1.0',
        });

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(mocks.fetch).toHaveBeenCalledTimes(6);
        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'downloaded',
            version: '1.2.0',
        });
    });

    it('keeps a cached downloaded update when a newer release has no updater metadata', async () => {
        mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(200);
            }
            return createMetadataResponse('1.1.0');
        });
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloaded',
            version: '1.1.0',
        });

        mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(404);
            }
            return createMetadataResponse('1.2.0');
        });

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            'Keeping cached downloaded update 1.1.0; newer release 1.2.0 has no latest.yml updater feed',
        );
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'downloaded',
            version: '1.1.0',
        });
    });

    it('skips the updater feed when the latest Windows release has no latest.yml', async () => {
        mocks.app.getVersion.mockReturnValue('1.0.0');
        mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(404);
            }
            return createMetadataResponse('1.1.0');
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(mocks.logger.info).toHaveBeenCalledWith(
            'Release 1.1.0 has no latest.yml updater feed; skipping in-app updater check',
        );
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            version: '1.0.0',
        });
    });

    it('throttles download progress broadcasts but still flushes the terminal update immediately', async () => {
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        mocks.autoUpdater.emit('download-progress', { percent: 10 });
        mocks.autoUpdater.emit('download-progress', { percent: 25 });
        mocks.autoUpdater.emit('download-progress', { percent: 50 });
        await flushPromises();

        expect(statuses).toHaveLength(3);
        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloading',
            percent: 0,
        });

        await vi.advanceTimersByTimeAsync(249);
        await flushPromises();
        expect(statuses).toHaveLength(3);

        await vi.advanceTimersByTimeAsync(1);
        await flushPromises();
        expect(statuses).toHaveLength(4);
        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloading',
            percent: 50,
        });

        mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloaded',
            percent: 100,
            version: '1.1.0',
        });
    });
});

afterAll(() => {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
    });
    Object.defineProperty(process, 'arch', {
        configurable: true,
        value: originalArch,
    });
});
