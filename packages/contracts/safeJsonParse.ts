function hasPrototypeKey(value: unknown) {
    return typeof value === 'object' && value !== null && 'prototype' in value;
}

function safeJsonReviver(key: string, value: unknown) {
    if (key === '__proto__') {
        throw new SyntaxError('Unsafe JSON key: __proto__');
    }
    if (key === 'constructor' && hasPrototypeKey(value)) {
        throw new SyntaxError('Unsafe JSON key: constructor.prototype');
    }
    return value;
}

export type TJsonValidator<T> = (value: unknown) => value is T;

export function safeJsonParse(source: string): unknown;
export function safeJsonParse<T>(source: string, validator: TJsonValidator<T>): T;
export function safeJsonParse<T>(source: string, validator?: TJsonValidator<T>) {
    const value = JSON.parse(source, safeJsonReviver) as unknown;
    if (validator && !validator(value)) {
        throw new SyntaxError('Invalid JSON payload');
    }
    return value;
}
