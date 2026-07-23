import {
    decodeHostResourceProfileSnapshot,
    type IHostResourceProfileSnapshot,
} from '@contracts/hostResourceProfile';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

export type THostPlatform = 'darwin' | 'win32' | 'linux';
const HOST_OS_SCALE_FACTOR_MAX = 8;

export interface IHostEnvironmentSnapshot {
    platform: THostPlatform;
    osScaleFactor: number;
}

export function decodeHostEnvironmentSnapshot(value: unknown): IHostEnvironmentSnapshot | null {
    if (
        !isRecord(value)
        || (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux')
        || !isFiniteNumber(value.osScaleFactor)
        || value.osScaleFactor <= 0
        || value.osScaleFactor > HOST_OS_SCALE_FACTOR_MAX
    ) {
        return null;
    }
    return {
        platform: value.platform,
        osScaleFactor: value.osScaleFactor,
    };
}

export interface IHostZenModeState {
    active: boolean;
    supported: boolean;
}

function decodeHostZenModeState(value: unknown): IHostZenModeState {
    if (!isRecord(value) || typeof value.active !== 'boolean' || typeof value.supported !== 'boolean') {
        throw new Error('invalid host zen mode state');
    }
    return {
        active: value.active,
        supported: value.supported,
    };
}

const resourceProfile = s.fromParser((value) => {
    if (value === null) {
        return null;
    }
    const profile = decodeHostResourceProfileSnapshot(value);
    if (!profile) {
        throw new Error('invalid host resource profile');
    }
    return profile;
}, (): IHostResourceProfileSnapshot => ({
    logicalCpus: 8,
    totalRamBytes: 16 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
}));
const environment = s.fromNullableDecoder<IHostEnvironmentSnapshot>(
    decodeHostEnvironmentSnapshot,
    'host environment',
    () => ({
        platform: 'linux',
        osScaleFactor: 1,
    }),
);
const zenMode = s.fromParser<IHostZenModeState>(decodeHostZenModeState, () => ({
    active: false,
    supported: true,
}));

export const HOST_PLATFORM_FEATURE = definePlatformFeature({
    path: ['host'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        getResourceProfile: {
            kind: 'sync',
            result: resourceProfile,
            browser: {method: 'getResourceProfile'},
            lazy: 'direct',
        },
        getEnvironment: {
            kind: 'async',
            channel: 'host:getEnvironment',
            ipc: {
                args: s.tuple([]),
                result: environment,
            },
            main: {
                method: 'snapshotHostEnvironmentForWindow',
                context: 'sender',
            },
            browser: {method: 'getEnvironment'},
            lazy: 'forwarded',
        },
        getZenModeState: {
            kind: 'async',
            channel: 'host:getZenModeState',
            ipc: {
                args: s.tuple([]),
                result: zenMode,
            },
            main: {
                method: 'snapshotHostZenModeForWindow',
                context: 'sender',
            },
            browser: {method: 'getZenModeState'},
            lazy: 'forwarded',
        },
        setZenMode: {
            kind: 'async',
            channel: 'host:setZenMode',
            ipc: {
                args: s.tuple([s.boolean()]),
                result: zenMode,
            },
            main: {
                method: 'setHostZenModeForWindow',
                context: 'sender',
            },
            browser: {method: 'setZenMode'},
            lazy: 'forwarded',
        },
    },
    events: {
        onEnvironmentChange: {
            kind: 'event',
            channel: 'host:environmentChanged',
            payload: environment,
            browser: {method: 'onEnvironmentChange'},
            lazy: 'forwarded',
        },
        onZenModeChange: {
            kind: 'event',
            channel: 'host:zenModeChanged',
            payload: zenMode,
            browser: {method: 'onZenModeChange'},
            lazy: 'forwarded',
        },
    },
});

export type IHostCapability = TFeatureCapability<typeof HOST_PLATFORM_FEATURE>;
