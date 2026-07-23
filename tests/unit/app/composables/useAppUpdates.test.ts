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
} from '@contracts/updatesPlatformFeature';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

type TUpdatesCapability = IUpdatesCapability | undefined;

const getUpdatesCapabilityMock = vi.hoisted(() => vi.fn<() => TUpdatesCapability>());
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

function requireStatusListener(listener: ((status: IAppUpdateStatus) => void) | null) {
    if (!listener) {
        throw new Error('Expected update status listener to be registered');
    }
    return listener;
}

describe('useAppUpdates', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('keeps browser state idle when the optional updates capability is absent', async () => {
        getUpdatesCapabilityMock.mockReturnValue(undefined);

        const { useAppUpdates } = await import('@app/composables/useAppUpdates');
        const updates = useAppUpdates();

        await expect(updates.ensureInitialized()).resolves.toBe(false);

        expect(updates.status.value.phase).toBe('idle');
        expect(updates.dialog.value.open).toBe(false);
    });

    it('routes manual check requests through the shared updates capability', async () => {
        let statusListener: ((status: IAppUpdateStatus) => void) | null = null;
        const idleStatus: IAppUpdateStatus = {
            phase: 'idle',
            origin: 'auto',
            version: null,
            percent: null,
            message: null,
        };
        const updatesCapability = createElectronPlatformApiFixture({updates: {
            getState: vi.fn(async () => idleStatus),
            check: vi.fn(async () => {
                statusListener?.({
                    ...idleStatus,
                    phase: 'unsupported',
                    origin: 'manual',
                });
                return {started: false};
            }),
            onStatus: vi.fn((callback: (status: IAppUpdateStatus) => void) => {
                statusListener = callback;
                return () => {};
            }),
        }}).updates;
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
        const initialState = Promise.withResolvers<IAppUpdateStatus>();
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
        const updatesCapability = createElectronPlatformApiFixture({updates: {
            getState: vi.fn(() => initialState.promise),
            onStatus: vi.fn((callback: (status: IAppUpdateStatus) => void) => {
                statusListener = callback;
                return () => {};
            }),
        }}).updates;
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

    it('prompts before an automatic download and starts it only on request', async () => {
        let statusListener: ((status: IAppUpdateStatus) => void) | null = null;
        const download = vi.fn(async () => ({ started: true }));
        const updatesCapability = createElectronPlatformApiFixture({updates: {
            download,
            onStatus: vi.fn((callback: (status: IAppUpdateStatus) => void) => {
                statusListener = callback;
                return () => {};
            }),
        }}).updates;
        getUpdatesCapabilityMock.mockReturnValue(updatesCapability);

        const { useAppUpdates } = await import('@app/composables/useAppUpdates');
        const updates = useAppUpdates();
        await updates.ensureInitialized();

        requireStatusListener(statusListener)({
            phase: 'available',
            origin: 'auto',
            version: '2.0.0',
            percent: null,
            message: null,
        });

        expect(download).not.toHaveBeenCalled();
        expect(updates.dialog.value).toMatchObject({
            open: true,
            kind: 'available',
            phase: 'available',
            version: '2.0.0',
        });

        await updates.downloadUpdate();
        expect(download).toHaveBeenCalledOnce();
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
        const updatesCapability = createElectronPlatformApiFixture({updates: {getState}}).updates;
        getUpdatesCapabilityMock.mockReturnValue(updatesCapability);

        const { useAppUpdates } = await import('@app/composables/useAppUpdates');
        const updates = useAppUpdates();

        await expect(updates.ensureInitialized()).resolves.toBe(false);
        await expect(updates.ensureInitialized()).resolves.toBe(true);

        expect(getState).toHaveBeenCalledTimes(2);
        expect(updates.status.value.phase).toBe('unsupported');
    });
});
