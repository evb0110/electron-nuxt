import type { IMenuEventUnsubscribe } from './electron-api-common';

export type THostPlatform = 'darwin' | 'win32' | 'linux';

export interface IHostEnvironmentSnapshot {
    platform: THostPlatform;
    osScaleFactor: number;
}

export interface IHostCapability {
    getEnvironment: () => Promise<IHostEnvironmentSnapshot>;
    onEnvironmentChange: (callback: (snapshot: IHostEnvironmentSnapshot) => void) => IMenuEventUnsubscribe;
}
