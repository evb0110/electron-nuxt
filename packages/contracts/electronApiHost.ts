import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
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

export interface IHostCapability {
    getResourceProfile: () => IHostResourceProfileSnapshot | null;
    getEnvironment: () => Promise<IHostEnvironmentSnapshot>;
    onEnvironmentChange: (callback: (snapshot: IHostEnvironmentSnapshot) => void) => TMenuEventUnsubscribe;
    getZenModeState: () => Promise<IHostZenModeState>;
    setZenMode: (active: boolean) => Promise<IHostZenModeState>;
    onZenModeChange: (callback: (state: IHostZenModeState) => void) => TMenuEventUnsubscribe;
}
