import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

export type TAppUpdateCheckOrigin = 'auto' | 'manual';
export type TAppUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'no-update' | 'error' | 'unsupported';

export interface IAppUpdateStatus {
    phase: TAppUpdatePhase;
    origin: TAppUpdateCheckOrigin;
    version: string | null;
    percent: number | null;
    message: string | null;
}

const APP_UPDATE_PHASES = [
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'no-update',
    'error',
    'unsupported',
] as const satisfies readonly TAppUpdatePhase[];
const APP_UPDATE_VERSION_MAX_LENGTH = 128;
const APP_UPDATE_MESSAGE_MAX_LENGTH = 4_096;

export function decodeAppUpdateStatus(value: unknown): IAppUpdateStatus | null {
    if (
        !isRecord(value)
        || typeof value.phase !== 'string'
        || !isOneOf(APP_UPDATE_PHASES, value.phase)
        || (value.origin !== 'auto' && value.origin !== 'manual')
        || (value.version !== null && (
            typeof value.version !== 'string'
            || value.version.length > APP_UPDATE_VERSION_MAX_LENGTH
        ))
        || (value.message !== null && (
            typeof value.message !== 'string'
            || value.message.length > APP_UPDATE_MESSAGE_MAX_LENGTH
        ))
        || (value.percent !== null && (
            !isFiniteNumber(value.percent)
            || value.percent < 0
            || value.percent > 100
        ))
    ) {
        return null;
    }

    return {
        phase: value.phase,
        origin: value.origin,
        version: value.version,
        percent: value.percent,
        message: value.message,
    };
}

function decodeStartedResult(value: unknown) {
    if (!isRecord(value) || typeof value.started !== 'boolean') {
        throw new Error('expected a started result');
    }
    return {started: value.started};
}

type TVoidResult = ReturnType<() => void>;

const noArgs = s.tuple([]);
const updateStatus = s.declared<IAppUpdateStatus>()(
    s.fromNullableDecoder(decodeAppUpdateStatus, 'app update status', () => ({
        phase: 'idle',
        origin: 'auto',
        version: null,
        percent: null,
        message: null,
    })),
);
const startedResult = s.fromParser(decodeStartedResult, () => ({started: true}));
const voidResult = s.declared<TVoidResult>()(s.undefined());
const browserUnsupported = {
    unsupported: 'omitted',
    reason: 'requires-native-backend',
} as const;

export const UPDATES_PLATFORM_FEATURE = definePlatformFeature({
    path: ['updates'],
    required: {
        browser: false,
        electron: true,
    },
    manifestPath: ['updates'],
    methods: {
        getState: {
            kind: 'async',
            channel: 'updates:getState',
            ipc: {
                args: noArgs,
                result: updateStatus,
            },
            main: {
                method: 'getUpdateStatus',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        check: {
            kind: 'async',
            channel: 'updates:check',
            ipc: {
                args: noArgs,
                result: startedResult,
            },
            main: {
                method: 'triggerManualUpdateCheck',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        download: {
            kind: 'async',
            channel: 'updates:download',
            ipc: {
                args: noArgs,
                result: startedResult,
            },
            main: {
                method: 'downloadAvailableUpdate',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        install: {
            kind: 'async',
            channel: 'updates:install',
            ipc: {
                args: noArgs,
                result: startedResult,
            },
            main: {
                method: 'installDownloadedUpdate',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        defer: {
            kind: 'async',
            channel: 'updates:defer',
            ipc: {
                args: noArgs,
                result: voidResult,
            },
            main: {
                method: 'deferDownloadedUpdate',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        skipVersion: {
            kind: 'async',
            channel: 'updates:skipVersion',
            ipc: {
                args: s.tuple([s.string('1.2.3')]),
                result: voidResult,
            },
            main: {
                method: 'skipUpdateVersion',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
    },
    events: {onStatus: {
        kind: 'event',
        channel: 'updates:status',
        payload: updateStatus,
        browser: browserUnsupported,
        lazy: 'forwarded',
    }},
});

interface IUpdatesMenuCapability {onMenuCheckForUpdates: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;}

export type IUpdatesCapability =
    TFeatureCapability<typeof UPDATES_PLATFORM_FEATURE> & IUpdatesMenuCapability;
export type IUpdatesInvokeMap = TFeatureInvokeMap<typeof UPDATES_PLATFORM_FEATURE>;
export type IUpdatesEventMap = TFeatureEventMap<typeof UPDATES_PLATFORM_FEATURE>;
