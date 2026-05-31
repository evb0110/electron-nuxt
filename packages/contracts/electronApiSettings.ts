import type { ISettingsData } from '@contracts/shared';
import type {
    IDebugLogEntry,
    IMenuEventCallback,
    IMenuEventUnsubscribe,
    IRendererLogEntry,
} from '@contracts/electronApiCommon';

export interface ISettingsCapability {
    get: () => Promise<ISettingsData>;
    save: (settings: Partial<ISettingsData>) => Promise<void>;
    getDebugLogs: () => Promise<IDebugLogEntry[]>;
    onDebugLog: (callback: (entry: IDebugLogEntry) => void) => IMenuEventUnsubscribe;
    rendererLog: (entry: IRendererLogEntry) => void;
    onMenuOpenSettings: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
}
