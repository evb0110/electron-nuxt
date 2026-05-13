import type { ISettingsData } from './shared';
import type {
    IDebugLogEntry,
    IMenuEventCallback,
    IMenuEventUnsubscribe,
    IRendererLogEntry,
} from './electronApiCommon';

export interface ISettingsCapability {
    get: () => Promise<ISettingsData>;
    save: (settings: ISettingsData) => Promise<void>;
    getDebugLogs: () => Promise<IDebugLogEntry[]>;
    onDebugLog: (callback: (entry: IDebugLogEntry) => void) => IMenuEventUnsubscribe;
    rendererLog: (entry: IRendererLogEntry) => void;
    onMenuOpenSettings: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
}
