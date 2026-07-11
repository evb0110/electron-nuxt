import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

export type TAppUpdateCheckOrigin = 'auto' | 'manual';
export type TAppUpdatePhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'no-update' | 'error' | 'unsupported';

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

export interface IUpdatesCapability {
    getState: () => Promise<IAppUpdateStatus>;
    check: () => Promise<{ started: boolean }>;
    install: () => Promise<{ started: boolean }>;
    defer: () => Promise<void>;
    skipVersion: (version: string) => Promise<void>;
    onStatus: (callback: (status: IAppUpdateStatus) => void) => TMenuEventUnsubscribe;
    onMenuCheckForUpdates: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
}
