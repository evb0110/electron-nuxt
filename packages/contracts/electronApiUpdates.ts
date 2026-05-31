import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

export type TAppUpdateCheckOrigin = 'auto' | 'manual';
export type TAppUpdatePhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'no-update' | 'error' | 'unsupported';

export interface IAppUpdateStatus {
    phase: TAppUpdatePhase;
    origin: TAppUpdateCheckOrigin;
    version: string | null;
    percent: number | null;
    message: string | null;
}

export interface IUpdatesCapability {
    getState: () => Promise<IAppUpdateStatus>;
    check: () => Promise<{ started: boolean }>;
    install: () => Promise<{ started: boolean }>;
    defer: () => Promise<void>;
    skipVersion: (version: string) => Promise<void>;
    onStatus: (callback: (status: IAppUpdateStatus) => void) => IMenuEventUnsubscribe;
    onMenuCheckForUpdates: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
}
