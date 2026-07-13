export interface ISystemMemoryInfo {
    availableBytes: number;
    totalBytes: number;
    freeBytes: number;
}

export interface IShutdownSaveFlushResponse {
    dirtyWorkingCopyPaths?: string[];
    flushedWorkingCopyPaths?: string[];
}

export interface ISystemCapability {
    getMemoryInfo: () => ISystemMemoryInfo | null;
    onShutdownSaveFlushRequest: (
        callback: () => Promise<IShutdownSaveFlushResponse> | IShutdownSaveFlushResponse,
    ) => () => void;
}
