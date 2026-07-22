import type {
    IScanCleanupPageOverride,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
    setScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';

export interface IScanCleanupMixedValue<T> {
    empty: boolean;
    mixed: boolean;
    value: T | undefined;
}

function areScanCleanupSelectionValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length
            && left.every((value, index) => areScanCleanupSelectionValuesEqual(value, right[index]));
    }
    if (
        left !== null
        && right !== null
        && typeof left === 'object'
        && typeof right === 'object'
    ) {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const leftKeys = Object.keys(leftRecord).sort();
        const rightKeys = Object.keys(rightRecord).sort();
        return areScanCleanupSelectionValuesEqual(leftKeys, rightKeys)
            && leftKeys.every(key => areScanCleanupSelectionValuesEqual(leftRecord[key], rightRecord[key]));
    }
    return false;
}

export function resolveScanCleanupMixedValue<T>(
    values: readonly T[],
    equals: (left: T, right: T) => boolean = areScanCleanupSelectionValuesEqual,
): IScanCleanupMixedValue<T> {
    const first = values[0];
    if (first === undefined) {
        return {
            empty: true,
            mixed: false,
            value: undefined,
        };
    }
    return {
        empty: false,
        mixed: values.slice(1).some(value => !equals(first, value)),
        value: first,
    };
}

export function updateScanCleanupPageOverrides(
    overrides: TScanCleanupPageOverrides,
    pages: Iterable<number>,
    update: (value: IScanCleanupPageOverride, page: number) => IScanCleanupPageOverride,
) {
    for (const page of pages) {
        if (!Number.isInteger(page) || page < 1) {
            continue;
        }
        const current = getScanCleanupPageOverride(overrides, page);
        setScanCleanupPageOverride(overrides, page, createScanCleanupPageOverride(update(current, page)));
    }
}
