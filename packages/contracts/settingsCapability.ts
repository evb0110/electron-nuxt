import type { ISettingsData } from '@contracts/shared';
import type {
    IDebugLogEntry,
    TMenuEventCallback,
    TMenuEventUnsubscribe,
    IRendererLogEntry,
} from '@contracts/electronApiCommon';

export interface ISettingsCapability {
    get: () => Promise<ISettingsData>;
    save: (settings: Partial<ISettingsData>) => Promise<void>;
    getDebugLogs: () => Promise<IDebugLogEntry[]>;
    onDebugLog: (callback: (entry: IDebugLogEntry) => void) => TMenuEventUnsubscribe;
    rendererLog: (entry: IRendererLogEntry) => void;
    onMenuOpenSettings: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
}
