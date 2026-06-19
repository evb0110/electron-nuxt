export type TMenuEventCallback = () => void;

export type TMenuEventUnsubscribe = () => void;

export type TDebugLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type TRendererLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IDebugLogEntry {
    source: string;
    message: string;
    timestamp: string;
    // Main-process diagnostic logs use the native Electron/logger channel casing.
    level?: TDebugLogLevel;
}

export interface IRendererLogEntry {
    // Renderer logs mirror BrowserLogger casing before they are bridged to main.
    level: TRendererLogLevel;
    section: string;
    message: string;
    timestamp: string;
    data?: unknown;
}
