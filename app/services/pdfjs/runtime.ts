import { isRecord } from '@contracts/runtimeGuards';

export { isRecord };

export function getOptionalString(
    value: unknown,
    key: PropertyKey,
) {
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
) {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
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

/**
 * @remarks The returned function is **unbound** — calling it directly will lose the
 * original `this` context.  Use `.call(value, ...)` at each call site, or prefer
 * structural type guards (see `annotationEditorAdapter.ts`) that narrow the original
 * object so methods keep their `this` binding.  Never store the result on a wrapper
 * object and call it there — that silently rebinds `this` to the wrapper.
 */
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
    if (!candidate || !candidate.every((item): item is number => typeof item === 'number' && Number.isFinite(item))) {
        return null;
    }

    return candidate;
}
