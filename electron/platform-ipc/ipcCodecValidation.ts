export function decodeBooleanResult(value: unknown): boolean {
    if (typeof value !== 'boolean') {
        throw new Error('expected a boolean IPC result');
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
