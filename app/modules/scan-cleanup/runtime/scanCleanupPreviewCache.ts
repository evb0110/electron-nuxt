import type {IScanCleanupPreviewResult} from '@contracts/electronApiScanCleanup';

/**
 * Preview payloads can be tens of MiB. Eight entries cover the visible page and
 * a useful navigation window; 96 MiB matches the IPC payload ceiling without
 * allowing a long document to retain an unbounded second copy in the renderer.
 */
export const SCAN_CLEANUP_PREVIEW_CACHE_MAX_ENTRIES = 8;
export const SCAN_CLEANUP_PREVIEW_CACHE_MAX_BYTES = 96 * 1024 * 1024;

interface ICachedPreview {
    byteLength: number;
    rawOutputIndex: number | null;
    result: Omit<IScanCleanupPreviewResult, 'rawImageData'> & {rawImageData?: Uint8Array};
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
    return left.buffer === right.buffer
        && left.byteOffset === right.byteOffset
        && left.byteLength === right.byteLength;
}

function compactPreview(result: IScanCleanupPreviewResult): ICachedPreview {
    const rawOutputIndex = result.outputs.findIndex(output => sameBytes(output.imageData, result.rawImageData));
    const retainedBuffers = new Set<ArrayBufferLike>();
    let byteLength = 0;
    const addBytes = (bytes: Uint8Array) => {
        if (!retainedBuffers.has(bytes.buffer)) {
            retainedBuffers.add(bytes.buffer);
            byteLength += bytes.buffer.byteLength;
        }
    };
    for (const output of result.outputs) addBytes(output.imageData);
    if (rawOutputIndex < 0) addBytes(result.rawImageData);
    const {
        rawImageData,
        ...rest
    } = result;
    return {
        byteLength,
        rawOutputIndex: rawOutputIndex < 0 ? null : rawOutputIndex,
        result: rawOutputIndex < 0 ? {
            ...rest,
            rawImageData,
        } : rest,
    };
}

function materializePreview(entry: ICachedPreview): IScanCleanupPreviewResult {
    const rawImageData = entry.rawOutputIndex === null
        ? entry.result.rawImageData
        : entry.result.outputs[entry.rawOutputIndex]?.imageData;
    if (!rawImageData) throw new Error('Scan cleanup preview cache entry lost its source raster');
    return {
        ...entry.result,
        rawImageData,
    };
}

export interface IScanCleanupPreviewCache {
    readonly byteLength: number;
    readonly size: number;
    clear: () => void;
    delete: (key: string) => boolean;
    get: (key: string) => IScanCleanupPreviewResult | undefined;
    has: (key: string) => boolean;
    set: (key: string, result: IScanCleanupPreviewResult) => void;
}

export function createScanCleanupPreviewCache(options: {
    maxEntries?: number;
    maxBytes?: number;
} = {}): IScanCleanupPreviewCache {
    const maxEntries = options.maxEntries ?? SCAN_CLEANUP_PREVIEW_CACHE_MAX_ENTRIES;
    const maxBytes = options.maxBytes ?? SCAN_CLEANUP_PREVIEW_CACHE_MAX_BYTES;
    const entries = new Map<string, ICachedPreview>();
    let totalBytes = 0;
    const remove = (key: string) => {
        const entry = entries.get(key);
        if (!entry) {
            return false;
        }
        entries.delete(key);
        totalBytes -= entry.byteLength;
        return true;
    };
    return {
        get byteLength() {
            return totalBytes;
        },
        get size() {
            return entries.size;
        },
        clear() {
            entries.clear();
            totalBytes = 0;
        },
        delete: remove,
        get(key) {
            const entry = entries.get(key);
            if (!entry) {
                return undefined;
            }
            entries.delete(key);
            entries.set(key, entry);
            return materializePreview(entry);
        },
        has: key => entries.has(key),
        set(key, result) {
            remove(key);
            const entry = compactPreview(result);
            entries.set(key, entry);
            totalBytes += entry.byteLength;
            while (entries.size > maxEntries || totalBytes > maxBytes) {
                const oldestKey = entries.keys().next().value;
                if (oldestKey === undefined) break;
                remove(oldestKey);
            }
        },
    };
}
