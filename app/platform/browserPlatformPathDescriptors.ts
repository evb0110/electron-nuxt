import {isRecord} from '@contracts/runtimeGuards';
import type { IPlatformApi } from '@contracts/platformApi';
import {
    browserPlatformPathDescriptorsGenerated,
    directBrowserPlatformMemberPathsGenerated,
} from '@app/platform/generated/browserPlatformPathDescriptorsGenerated';

type TCapabilityKey = keyof IPlatformApi;
type TCallablePlatformMember<TMember> =
    NonNullable<TMember> extends (...args: infer TArgs) => infer TResult
        ? (...args: TArgs) => TResult
        : never;

type TCallableMemberKey<TTarget> = Extract<{
    [TKey in keyof NonNullable<TTarget>]: TCallablePlatformMember<NonNullable<TTarget>[TKey]> extends never
        ? never
        : TKey;
}[keyof NonNullable<TTarget>], string>;

type TObjectMemberKey<TTarget> = Extract<{
    [TKey in keyof NonNullable<TTarget>]: TCallablePlatformMember<NonNullable<TTarget>[TKey]> extends never
        ? NonNullable<NonNullable<TTarget>[TKey]> extends object
            ? TKey
            : never
        : never;
}[keyof NonNullable<TTarget>], string>;

export type TBrowserPlatformMethodPath = {
    [TKey in TCapabilityKey]: readonly [
        TKey,
        TCallableMemberKey<IPlatformApi[TKey]>,
    ];
}[TCapabilityKey] | {
    [TKey in TCapabilityKey]: {
        [TOwnerKey in TObjectMemberKey<IPlatformApi[TKey]>]: readonly [
            TKey,
            TOwnerKey,
            TCallableMemberKey<NonNullable<NonNullable<IPlatformApi[TKey]>[TOwnerKey]>>,
        ];
    }[TObjectMemberKey<IPlatformApi[TKey]>];
}[TCapabilityKey];

export type TMethodAtBrowserPlatformPath<TPath extends TBrowserPlatformMethodPath> =
    TPath extends readonly [infer TCapabilityKey, infer TMethodKey]
        ? TCapabilityKey extends keyof IPlatformApi
            ? TMethodKey extends keyof NonNullable<IPlatformApi[TCapabilityKey]>
                ? TCallablePlatformMember<NonNullable<IPlatformApi[TCapabilityKey]>[TMethodKey]>
                : never
            : never
        : TPath extends readonly [infer TCapabilityKey, infer TOwnerKey, infer TMethodKey]
            ? TCapabilityKey extends keyof IPlatformApi
                ? TOwnerKey extends keyof NonNullable<IPlatformApi[TCapabilityKey]>
                    ? TMethodKey extends keyof NonNullable<NonNullable<IPlatformApi[TCapabilityKey]>[TOwnerKey]>
                        ? TCallablePlatformMember<NonNullable<NonNullable<IPlatformApi[TCapabilityKey]>[TOwnerKey]>[TMethodKey]>
                        : never
                    : never
                : never
            : never;

export type TBrowserPlatformAsyncMethodPath = TBrowserPlatformMethodPath;
export type TBrowserPlatformEventMethodPath = TBrowserPlatformMethodPath;
export type TBrowserPlatformVoidMethodPath = TBrowserPlatformMethodPath;

type TBrowserPlatformPathDescriptor =
    | {
        kind: 'async' | 'sync';
        path: TBrowserPlatformAsyncMethodPath;
    }
    | {
        kind: 'event';
        path: TBrowserPlatformEventMethodPath;
    }
    | {
        kind: 'void';
        path: TBrowserPlatformVoidMethodPath;
    };

function isBrowserPlatformPathDescriptor(value: unknown): value is TBrowserPlatformPathDescriptor {
    return isRecord(value)
        && (value.kind === 'async' || value.kind === 'sync' || value.kind === 'event' || value.kind === 'void')
        && Array.isArray(value.path);
}

function collectBrowserPlatformPathDescriptors(
    value: unknown,
    descriptors: TBrowserPlatformPathDescriptor[] = [],
) {
    if (isBrowserPlatformPathDescriptor(value)) {
        descriptors.push(value);
        return descriptors;
    }
    if (!isRecord(value)) {
        return descriptors;
    }
    for (const child of Object.values(value)) {
        collectBrowserPlatformPathDescriptors(child, descriptors);
    }
    return descriptors;
}

export const browserPlatformPathDescriptors = browserPlatformPathDescriptorsGenerated;

export const directBrowserPlatformMemberPaths = directBrowserPlatformMemberPathsGenerated;

export const browserPlatformPathDescriptorList = collectBrowserPlatformPathDescriptors(
    browserPlatformPathDescriptors,
);
