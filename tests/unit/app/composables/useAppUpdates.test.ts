import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAppUpdateStatus,
    IUpdatesCapability,
} from '@contracts/electronApiUpdates';

const getUpdatesCapabilityMock = vi.hoisted(() => vi.fn<() => IUpdatesCapability>());
const isUpdatesCapabilitySupportedMock = vi.hoisted(() => vi.fn((status: IAppUpdateStatus) => status.phase !== 'unsupported'));
const browserLoggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/platformUpdates', () => ({
    getUpdatesCapability: getUpdatesCapabilityMock,
    isUpdatesCapabilitySupported: isUpdatesCapabilitySupportedMock,
}));

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: browserLoggerErrorMock,
} }));

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

function requireStatusListener(listener: ((status: IAppUpdateStatus) => void) | null) {
    if (!listener) {
        throw new Error('Expected update status listener to be registered');
    }
    return listener;
}

function createUpdatesCapability(overrides: Partial<IUpdatesCapability> = {}): IUpdatesCapability {
    const listeners = new Set<(status: IAppUpdateStatus) => void>();
    const unsupportedStatus: IAppUpdateStatus = {
        phase: 'unsupported',
        origin: 'auto',
        version: null,
        percent: null,
        message: null,
    };
    const manualUnsupportedStatus: IAppUpdateStatus = {
        phase: 'unsupported',
        origin: 'manual',
        version: null,
        percent: null,
        message: null,
    };

    return {
        getState: vi.fn(async () => unsupportedStatus),
        check: vi.fn(async () => {
            listeners.forEach((listener) => {
                listener(manualUnsupportedStatus);
            });
            return { started: false };
        }),
        install: vi.fn(async () => ({ started: false })),
        defer: vi.fn(async () => {}),
        skipVersion: vi.fn(async () => {}),
        onStatus: vi.fn((callback: (status: IAppUpdateStatus) => void) => {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            };
        }),
        onMenuCheckForUpdates: vi.fn(() => () => {}),
        ...overrides,
    };
}

describe('useAppUpdates', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('treats unsupported browser updates as a valid platform capability state', async () => {
        const updatesCapability = createUpdatesCapability();
        getUpdatesCapabilityMock.mockReturnValue(updatesCapability);

        const { useAppUpdates } = await import('@app/composables/useAppUpdates');
        const updates = useAppUpdates();

        await updates.ensureInitialized();

        expect(updatesCapability.getState).toHaveBeenCalledOnce();
        expect(updates.status.value.phase).toBe('unsupported');
        expect(updates.isUpdateSupported.value).toBe(false);
        expect(isUpdatesCapabilitySupportedMock).toHaveBeenCalledWith(expect.objectContaining({ phase: 'unsupported' }));
    });

    it('routes manual check requests through the shared updates capability', async () => {
        const idleStatus: IAppUpdateStatus = {
            phase: 'idle',
            origin: 'auto',
            version: null,
            percent: null,
            message: null,
        };
        const updatesCapability = createUpdatesCapability({ getState: vi.fn(async () => idleStatus) });
        getUpdatesCapabilityMock.mockReturnValue(updatesCapability);

        const { useAppUpdates } = await import('@app/composables/useAppUpdates');
        const updates = useAppUpdates();

        await updates.checkForUpdates();

        expect(updatesCapability.getState).toHaveBeenCalledOnce();
        expect(updatesCapability.check).toHaveBeenCalledOnce();
        expect(updates.status.value.phase).toBe('unsupported');
        expect(updates.status.value.origin).toBe('manual');
        expect(updates.dialog.value.open).toBe(true);
        expect(updates.dialog.value.kind).toBe('status');
    });

    it('keeps pushed update status when it arrives before the initial state fetch resolves', async () => {
        const initialState = createDeferred<IAppUpdateStatus>();
        let statusListener: ((status: IAppUpdateStatus) => void) | null = null;
        const idleStatus: IAppUpdateStatus = {
            phase: 'idle',
            origin: 'auto',
            version: null,
            percent: null,
            message: null,
        };
        const pushedStatus: IAppUpdateStatus = {
            phase: 'downloaded',
            origin: 'auto',
            version: '2.0.0',
            percent: 100,
            message: null,
        };
        const updatesCapability = createUpdatesCapability({
            getState: vi.fn(() => initialState.promise),
            onStatus: vi.fn((callback: (status: IAppUpdateStatus) => void) => {
                statusListener = callback;
                return () => {};
            }),
        });
        getUpdatesCapabilityMock.mockReturnValue(updatesCapability);

        const { useAppUpdates } = await import('@app/composables/useAppUpdates');
        const updates = useAppUpdates();
        const initializedPromise = updates.ensureInitialized();

        expect(updatesCapability.onStatus).toHaveBeenCalledOnce();
        const registeredStatusListener = requireStatusListener(statusListener);
        registeredStatusListener(pushedStatus);
        initialState.resolve(idleStatus);
        await initializedPromise;

        expect(updatesCapability.getState).toHaveBeenCalledOnce();
        expect(updates.status.value).toEqual(pushedStatus);
        expect(updates.dialog.value).toMatchObject({
            open: true,
            kind: 'ready',
            version: '2.0.0',
        });
    });

    it('retries initialization after an initial state fetch failure', async () => {
        const unsupportedStatus: IAppUpdateStatus = {
            phase: 'unsupported',
            origin: 'auto',
            version: null,
            percent: null,
            message: null,
        };
        const getState = vi.fn()
            .mockRejectedValueOnce(new Error('first failure'))
            .mockResolvedValueOnce(unsupportedStatus);
        const updatesCapability = createUpdatesCapability({ getState });
        getUpdatesCapabilityMock.mockReturnValue(updatesCapability);

        const { useAppUpdates } = await import('@app/composables/useAppUpdates');
        const updates = useAppUpdates();

        await expect(updates.ensureInitialized()).resolves.toBe(false);
        await expect(updates.ensureInitialized()).resolves.toBe(true);

        expect(getState).toHaveBeenCalledTimes(2);
        expect(updates.status.value.phase).toBe('unsupported');
    });
});
