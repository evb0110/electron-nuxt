import { isRecord } from '@contracts/runtimeGuards';

// fallow-ignore-next-line unused-export
export const IPC_MAX_BINARY_PAYLOAD_BYTES = 512 * 1024 * 1024;

export function decodeStringArg(args: readonly unknown[], index: number, fieldName: string): string {
    const value = args[index];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }
    return value;
}

export function decodeOptionalStringArg(args: readonly unknown[], index: number, fieldName: string): string | undefined {
    const value = args[index];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    return value;
}

// fallow-ignore-next-line unused-export
export function decodeBooleanArg(args: readonly unknown[], index: number, fieldName: string): boolean {
    const value = args[index];
    if (typeof value !== 'boolean') {
        throw new Error(`${fieldName} must be a boolean`);
    }
    return value;
}

export function decodeSafeIntegerArg(args: readonly unknown[], index: number, fieldName: string, min = 0): number {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

// fallow-ignore-next-line unused-export
export function decodeUint8ArrayArg(
    args: readonly unknown[],
    index: number,
    fieldName: string,
    maxBytes = IPC_MAX_BINARY_PAYLOAD_BYTES,
): Uint8Array {
    const value = args[index];
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength > maxBytes) {
        throw new Error(`${fieldName} exceeds maximum size (${maxBytes} bytes)`);
    }
    return value;
}

export function decodePositiveIntegerArrayArg(args: readonly unknown[], index: number, fieldName: string): number[] {
    const value = args[index];
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty array`);
    }
    const items = value as unknown[];
    for (const item of items) {
        if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) {
            throw new Error(`${fieldName} must contain positive safe integers`);
        }
    }
    return items as number[];
}

export function decodeStringArrayArg(args: readonly unknown[], index: number, fieldName: string): string[] {
    const value = args[index];
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array of non-empty strings`);
    }
    const items = value as unknown[];
    if (items.some(item => typeof item !== 'string' || item.trim().length === 0)) {
        throw new Error(`${fieldName} must be an array of non-empty strings`);
    }
    return items as string[];
}

export function decodeOptionalObjectWithKeys<T extends Record<string, unknown>>(
    value: unknown,
    fieldName: string,
    allowedKeys: readonly string[],
): T | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object`);
    }
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`${fieldName} contains unsupported key "${key}"`);
        }
    }
    return value as T;
}

// fallow-ignore-next-line unused-export
export function decodeRecordArg<T extends Record<string, unknown>>(
    args: readonly unknown[],
    index: number,
    fieldName: string,
): T {
    const value = args[index];
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object`);
    }
    return value as T;
}
