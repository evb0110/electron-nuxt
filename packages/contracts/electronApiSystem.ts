export interface ISystemMemoryInfo {
    totalBytes: number;
    freeBytes: number;
}

export interface ISystemCapability { getMemoryInfo: () => ISystemMemoryInfo | null; }
