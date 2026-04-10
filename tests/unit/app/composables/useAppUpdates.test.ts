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
} from '@contracts/platform-api';

const getUpdatesCapabilityMock = vi.hoisted(() => vi.fn<() => IUpdatesCapability>());
const isUpdatesCapabilitySupportedMock = vi.hoisted(() => vi.fn((status: IAppUpdateStatus) => status.phase !== 'unsupported'));
const browserLoggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/platform-updates', () => ({
    getUpdatesCapability: getUpdatesCapabilityMock,
    isUpdatesCapabilitySupported: isUpdatesCapabilitySupportedMock,
}));

vi.mock('@app/utils/browser-logger', () => ({ BrowserLogger: { error: browserLoggerErrorMock } }));

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
});
