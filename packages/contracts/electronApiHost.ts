import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';

export type THostPlatform = 'darwin' | 'win32' | 'linux';

export interface IHostEnvironmentSnapshot {
    platform: THostPlatform;
    osScaleFactor: number;
}

export interface IHostZenModeState {
    active: boolean;
    supported: boolean;
}

export interface IHostCapability {
    getEnvironment: () => Promise<IHostEnvironmentSnapshot>;
    onEnvironmentChange: (callback: (snapshot: IHostEnvironmentSnapshot) => void) => TMenuEventUnsubscribe;
    getZenModeState: () => Promise<IHostZenModeState>;
    setZenMode: (active: boolean) => Promise<IHostZenModeState>;
    onZenModeChange: (callback: (state: IHostZenModeState) => void) => TMenuEventUnsubscribe;
}
