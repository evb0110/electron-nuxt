export function toUint8Array(data: Uint8Array | ArrayBuffer) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function cloneBytes(data: Uint8Array) {
    return data.slice();
}

export function normalizePersistedBytes(data: unknown) {
    if (data instanceof Uint8Array) {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    return null;
}

export function normalizePersistedWriteBytes(
    data: Uint8Array | ArrayBuffer,
    cloneData = true,
) {
    const bytes = toUint8Array(data);
    return cloneData ? cloneBytes(bytes) : bytes;
}

export function normalizeReadRange(offset: number, length: number) {
    const start = Math.max(0, Math.floor(offset));
    const rangeLength = Math.max(0, Math.floor(length));

    return {
        start,
        rangeLength,
        end: start + rangeLength,
    };
}
