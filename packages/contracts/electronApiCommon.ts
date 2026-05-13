export interface IMenuEventCallback {(): void;}

export interface IMenuEventUnsubscribe {(): void;}

export interface IDebugLogEntry {
    source: string;
    message: string;
    timestamp: string;
}

export interface IRendererLogEntry {
    level: 'debug' | 'info' | 'warn' | 'error';
    section: string;
    message: string;
    timestamp: string;
    data?: unknown;
}
