export function requireIpcArgumentCount(
    args: readonly unknown[],
    expected: number | {
        max: number;
        min: number
    },
) {
    const min = typeof expected === 'number' ? expected : expected.min;
    const max = typeof expected === 'number' ? expected : expected.max;
    if (args.length < min || args.length > max) {
        const expectedLabel = min === max ? String(min) : `${min}-${max}`;
        throw new Error(`expected ${expectedLabel} arguments, received ${args.length}`);
    }
}

export function decodeUndefinedResult(value: unknown): undefined {
    if (value !== undefined) {
        throw new Error('expected an undefined IPC result');
    }
    return undefined;
}

export function decodeBooleanResult(value: unknown): boolean {
    if (typeof value !== 'boolean') {
        throw new Error('expected a boolean IPC result');
    }
    return value;
}

export function decodeStringResult(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('expected a string IPC result');
    }
    return value;
}

export function decodeNullableStringResult(value: unknown): string | null {
    if (value !== null && typeof value !== 'string') {
        throw new Error('expected a string or null IPC result');
    }
    return value;
}

export function decodeUint8ArrayResult(value: unknown): Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw new Error('expected a Uint8Array IPC result');
    }
    return value;
}

export function requireDecoded<T>(
    value: unknown,
    decode: (candidate: unknown) => T | null,
    label: string,
): T {
    const decoded = decode(value);
    if (decoded === null) {
        throw new Error(`invalid ${label} IPC result`);
    }
    return decoded;
}
