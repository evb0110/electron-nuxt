export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null;
}

export function getOptionalString(
    value: unknown,
    key: PropertyKey,
): string | null {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = value[key];
    return typeof candidate === 'string'
        ? candidate
        : null;
}

export function getOptionalNumber(
    value: unknown,
    key: PropertyKey,
): number | null {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
        ? candidate
        : null;
}

export function getOptionalBoolean(
    value: unknown,
    key: PropertyKey,
): boolean | null {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = value[key];
    return typeof candidate === 'boolean'
        ? candidate
        : null;
}

export function getOptionalArray(
    value: unknown,
    key: PropertyKey,
): unknown[] | null {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = value[key];
    return Array.isArray(candidate)
        ? candidate
        : null;
}

export function getOptionalObject(
    value: unknown,
    key: PropertyKey,
): Record<PropertyKey, unknown> | null {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = value[key];
    return isRecord(candidate)
        ? candidate
        : null;
}

export function getOptionalFunction<TArgs extends unknown[] = unknown[], TResult = unknown>(
    value: unknown,
    key: PropertyKey,
): ((...args: TArgs) => TResult) | null {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = value[key];
    return typeof candidate === 'function'
        ? candidate as (...args: TArgs) => TResult
        : null;
}

export function getOptionalNumberArray(
    value: unknown,
    key: PropertyKey,
): number[] | null {
    const candidate = getOptionalArray(value, key);
    if (!candidate || !candidate.every(item => typeof item === 'number' && Number.isFinite(item))) {
        return null;
    }

    return candidate as number[];
}
