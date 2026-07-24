/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
    IPlatformApiDescriptor,
    IPlatformMethodDescriptor,
} from '@contracts/platformDescriptorTypes';
import type { TPlatformBackend } from '@contracts/platformManifest';

export interface IRuntimeSchema<T> {
    decode: (value: unknown) => T;
    encode: {bivarianceHack(value: T): unknown}['bivarianceHack'];
    example: () => T;
}

export type TInferSchema<T> = T extends IRuntimeSchema<infer TValue> ? TValue : never;

type TPlatformBrowserSpec = {method: string} | {
    unsupported: 'omitted';
    reason: 'unsupported-backend' | 'requires-native-backend' | 'not-implemented';
};

const fail = (message: string): never => {
    throw new Error(message);
};

const schema = <T>(
    decode: (value: unknown) => T,
    example: () => T,
    encode: (value: T) => unknown = decode,
): IRuntimeSchema<T> => ({
    decode,
    encode,
    example,
});

export const runtimeSchema = {
    boolean(example = false) {
        const decode = (value: unknown) => typeof value === 'boolean'
            ? value
            : fail('expected a boolean IPC result');
        return schema(decode, () => example);
    },
    string(example = '') {
        const decode = (value: unknown) => typeof value === 'string'
            ? value
            : fail('expected a string');
        return schema(decode, () => example);
    },
    undefined() {
        const decode = (value: unknown) => value === undefined
            ? undefined
            : fail('expected an undefined IPC result');
        return schema(decode, () => undefined);
    },
    tuple<const TSchemas extends ReadonlyArray<IRuntimeSchema<unknown>>>(schemas: TSchemas) {
        type TValue = {-readonly [TKey in keyof TSchemas]: TInferSchema<TSchemas[TKey]>};
        const rebuild = (value: unknown, encode: boolean) => {
            if (!Array.isArray(value) || value.length !== schemas.length) {
                fail(`expected ${schemas.length} arguments, received ${Array.isArray(value) ? value.length : 0}`);
            }
            const items = value as unknown[];
            return schemas.map((itemSchema, index) => encode
                ? itemSchema.encode(items[index] as never)
                : itemSchema.decode(items[index])) as TValue;
        };
        return schema(
            value => rebuild(value, false),
            () => schemas.map(itemSchema => itemSchema.example()) as TValue,
            value => rebuild(value, true),
        );
    },
    optional<T>(itemSchema: IRuntimeSchema<T>) {
        return schema(
            value => value === undefined ? undefined : itemSchema.decode(value),
            () => undefined,
            value => value === undefined ? undefined : itemSchema.encode(value),
        );
    },
    array<T>(itemSchema: IRuntimeSchema<T>, example: readonly T[] = []) {
        const decode = (value: unknown) => Array.isArray(value)
            ? value.map(item => itemSchema.decode(item))
            : fail('expected an array');
        return schema(
            decode,
            () => example.map(item => itemSchema.decode(item)),
            value => value.map(item => itemSchema.encode(item)),
        );
    },
    fromParser<T>(parse: (value: unknown) => T, example: () => T) {
        return schema(parse, example);
    },
    fromNullableDecoder<T>(decodeNullable: (value: unknown) => T | null, label: string, example: () => T) {
        const decode = (value: unknown) => decodeNullable(value) ?? fail(`invalid ${label}`);
        return schema(decode, example);
    },
    declared<T>() {
        return (declaredSchema: IRuntimeSchema<T>) => declaredSchema;
    },
    trustedDirect<T>(example: () => T) {
        return schema(value => value as T, example);
    },
};

export function defineForwardedPlatformMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
    const TMain extends string,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    main: TMain;
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
        },
        main: {
            method: definition.main,
            context: 'sender',
        },
        browser: {method: definition.name},
        lazy: 'forwarded',
    } as const;
}

export function defineForwardedPlatformEvent<
    const TName extends string,
    const TChannel extends string,
    const TPayload extends IRuntimeSchema<unknown>,
>(definition: {
    name: TName;
    channel: TChannel;
    payload: TPayload;
}) {
    return {
        kind: 'event',
        channel: definition.channel,
        payload: definition.payload,
        browser: {method: definition.name},
        lazy: 'forwarded',
    } as const;
}

export interface IPlatformIpcMethodSpec<
    TArgs extends IRuntimeSchema<unknown[]> = IRuntimeSchema<unknown[]>,
    TResult extends IRuntimeSchema<unknown> = IRuntimeSchema<unknown>,
> {
    kind: 'async' | 'void';
    channel: string;
    ipc: {
        args: TArgs;
        result: TResult;
        timeoutMs?: number;
    };
    client?: {mapArgs: (...args: never[]) => TInferSchema<TArgs>};
    main: {
        method: string;
        context: 'none' | 'sender';
    };
    browser: TPlatformBrowserSpec;
    required?: Partial<Record<TPlatformBackend, boolean>>;
    optionalWhenImplemented?: boolean;
    lazy: 'forwarded' | 'direct';
}

export interface IPlatformSyncMethodSpec<
    TArgs extends IRuntimeSchema<unknown[]> = IRuntimeSchema<unknown[]>,
    TResult extends IRuntimeSchema<unknown> = IRuntimeSchema<unknown>,
> {
    kind: 'sync';
    args: TArgs;
    result: TResult;
    browser: TPlatformBrowserSpec;
    required?: Partial<Record<TPlatformBackend, boolean>>;
    optionalWhenImplemented?: boolean;
    lazy: 'direct';
}

export interface IPlatformLocalMethodSpec<
    TArgs extends IRuntimeSchema<unknown[]> = IRuntimeSchema<unknown[]>,
    TResult extends IRuntimeSchema<unknown> = IRuntimeSchema<unknown>,
> {
    kind: 'async' | 'void';
    local: {
        args: TArgs;
        result: TResult;
    };
    browser: TPlatformBrowserSpec;
    required?: Partial<Record<TPlatformBackend, boolean>>;
    optionalWhenImplemented?: boolean;
    lazy: 'forwarded' | 'direct';
}

export type TPlatformMethodSpec =
    | IPlatformIpcMethodSpec
    | IPlatformLocalMethodSpec
    | IPlatformSyncMethodSpec;

export interface IPlatformEventSpec<TPayload extends IRuntimeSchema<any> = IRuntimeSchema<any>> {
    kind: 'event';
    channel: string;
    payload: TPayload;
    subscription?: {
        channel: string;
        request: 'once-per-preload-event-channel';
        main: {
            method: string;
            context: 'sender';
        };
        replay?: {
            owner: 'ipc-progress-pump';
            mode: 'latest-per-key';
            key: (payload: TInferSchema<TPayload>) => string;
            terminal: (payload: TInferSchema<TPayload>) => boolean;
            intervalMs: number;
            terminalRetentionMs: number;
        };
    };
    browser: TPlatformBrowserSpec;
    lazy: 'forwarded' | 'direct';
}

type TMethods = Record<string, TPlatformMethodSpec>;
type TEvents = Record<string, IPlatformEventSpec>;

interface IFeatureInput<TMethodMap extends TMethods, TEventMap extends TEvents> {
    path: readonly [string, ...string[]];
    capabilityPath?: readonly [string, ...string[]];
    required: Record<TPlatformBackend, boolean>;
    manifestPath?: readonly string[];
    methods: TMethodMap;
    events?: TEventMap;
}

type TPublicMethod<TSpec extends TPlatformMethodSpec> =
    TSpec extends IPlatformSyncMethodSpec<infer TArgs, infer TResult>
        ? (...args: TInferSchema<TArgs>) => TInferSchema<TResult>
        : TSpec extends IPlatformLocalMethodSpec<infer TArgs, infer TResult>
            ? (...args: TInferSchema<TArgs>) => TSpec['kind'] extends 'async'
                ? Promise<TInferSchema<TResult>>
                : TInferSchema<TResult>
            : TSpec extends IPlatformIpcMethodSpec
                ? (
                    ...args: TSpec['client'] extends {mapArgs: (...args: infer TArgs) => unknown}
                        ? TArgs
                        : Extract<TInferSchema<TSpec['ipc']['args']>, unknown[]>
                ) => TSpec['kind'] extends 'async'
                    ? Promise<TInferSchema<TSpec['ipc']['result']>>
                    : TInferSchema<TSpec['ipc']['result']>
                : never;

type TRequiredCapabilityMethods<TMethodMap extends TMethods> = {
    [TKey in keyof TMethodMap as TMethodMap[TKey] extends {optionalWhenImplemented: true}
        ? never
        : TKey]: TPublicMethod<TMethodMap[TKey]>
};
type TOptionalCapabilityMethods<TMethodMap extends TMethods> = {
    [TKey in keyof TMethodMap as TMethodMap[TKey] extends {optionalWhenImplemented: true}
        ? TKey
        : never]?: TPublicMethod<TMethodMap[TKey]>
};
type TCapability<TMethodMap extends TMethods, TEventMap extends TEvents> =
    TRequiredCapabilityMethods<TMethodMap>
    & TOptionalCapabilityMethods<TMethodMap>
    & {
        [TKey in keyof TEventMap]:
        (callback: (payload: TInferSchema<TEventMap[TKey]['payload']>) => void) => (() => void)
    };

export type TFeatureCapability<T> = T extends IDefinedPlatformFeature<infer M, infer E>
    ? TCapability<M, E>
    : never;

type TMethodInvokeMap<M extends TMethods> = {
    [K in keyof M as M[K] extends IPlatformIpcMethodSpec
        ? M[K]['channel']
        : never]: M[K] extends IPlatformIpcMethodSpec ? {
        args: Extract<TInferSchema<M[K]['ipc']['args']>, unknown[]>;
        result: TInferSchema<M[K]['ipc']['result']>;
    } : never
};

type TSubscriptionInvokeMap<E extends TEvents> = {
    [K in keyof E as E[K]['subscription'] extends {channel: infer C extends string} ? C : never]: {
        args: [];
        result: undefined;
    }
};
type TFeatureCodecMap<M extends TMethods, E extends TEvents> = {
    [TChannel in keyof (TMethodInvokeMap<M> & TSubscriptionInvokeMap<E>)]:
    (TMethodInvokeMap<M> & TSubscriptionInvokeMap<E>)[TChannel] extends {
        args: infer TArgs extends unknown[];
        result: infer TResult;
    } ? {
            encodeArgs: (value: unknown[]) => TArgs;
            decodeArgs: (value: readonly unknown[]) => TArgs;
            decodeResult: (value: unknown) => TResult;
        }
        : never;
};

export type TFeatureInvokeMap<T> = T extends IDefinedPlatformFeature<infer M, infer E>
    ? TMethodInvokeMap<M> & TSubscriptionInvokeMap<E>
    : never;

export type TFeatureEventMap<T> = T extends IDefinedPlatformFeature<any, infer E>
    ? {[K in keyof E as E[K]['channel']]: TInferSchema<E[K]['payload']>}
    : never;

export interface IPlatformMainSenderContext<TSender> {
    sender: TSender;
    senderId: number;
}

type TSender<TEvent> = TEvent extends {sender: infer S} ? IPlatformMainSenderContext<S>
    : never;

type TMainMethod<TSpec extends IPlatformIpcMethodSpec, TEvent> = (
    ...args: TSpec['main']['context'] extends 'sender'
        ? [TSender<TEvent>, ...Extract<TInferSchema<TSpec['ipc']['args']>, unknown[]>]
        : Extract<TInferSchema<TSpec['ipc']['args']>, unknown[]>
) => TInferSchema<TSpec['ipc']['result']> | Promise<TInferSchema<TSpec['ipc']['result']>>;

export type TFeatureMainBindings<T, TEvent> = T extends {
    methods: infer M extends TMethods;
    events: infer E extends TEvents;
}
    ? {[K in keyof M as M[K] extends IPlatformIpcMethodSpec
        ? M[K] extends {main: {method: infer Name extends string}} ? Name : never
        : never]: M[K] extends IPlatformIpcMethodSpec ? TMainMethod<M[K], TEvent> : never} & {
            [K in keyof E as E[K]['subscription'] extends
            {main: {method: infer Name extends string}} ? Name : never]:
            (context: TSender<TEvent>) => void
        }
    : never;

export type TFeatureBrowserBindings<T> = TFeatureCapability<T>;
type TRequiredDirectBindings<M extends TMethods> = {
    [K in keyof M as M[K] extends IPlatformSyncMethodSpec | IPlatformLocalMethodSpec
        ? M[K] extends {optionalWhenImplemented: true} ? never : K
        : never]: TPublicMethod<M[K]>
};
type TOptionalDirectBindings<M extends TMethods> = {
    [K in keyof M as M[K] extends IPlatformSyncMethodSpec | IPlatformLocalMethodSpec
        ? M[K] extends {optionalWhenImplemented: true} ? K : never
        : never]?: TPublicMethod<M[K]>
};
export type TFeatureDirectBindings<T> = T extends {methods: infer M extends TMethods}
    ? TRequiredDirectBindings<M> & TOptionalDirectBindings<M>
    : never;
export type TFeatureSyncBindings<T> = TFeatureDirectBindings<T>;

type TFeatureInvokeChannels<M extends TMethods, E extends TEvents> =
    {readonly [K in keyof M as M[K] extends IPlatformIpcMethodSpec ? K : never]:
        M[K] extends IPlatformIpcMethodSpec ? M[K]['channel'] : never} & {
            readonly [K in keyof E as E[K]['subscription'] extends
            {main: {method: infer Name extends string}} ? Name : never]: string
        };

type TFeatureEventChannels<E extends TEvents> = {readonly [K in keyof E]: E[K]['channel']};

interface IPlatformFeatureCodec {
    encodeArgs: (value: unknown[]) => unknown[];
    decodeArgs: (value: readonly unknown[]) => unknown[];
    decodeResult: (value: unknown) => unknown;
}

export interface IDefinedPlatformFeature<M extends TMethods, E extends TEvents>
    extends IFeatureInput<M, E> {
    events: E;
    platformDescriptors: IPlatformApiDescriptor;
    invokeChannels: TFeatureInvokeChannels<M, E>;
    invokeChannelSet: ReadonlySet<string>;
    eventChannels: TFeatureEventChannels<E>;
    ipcCodecs: TFeatureCodecMap<M, E> & Readonly<Record<string, IPlatformFeatureCodec>>;
    fixtureMethods: ReadonlyArray<{
        descriptor: IPlatformMethodDescriptor;
        example: () => unknown;
    }>;
}

export type TAnyDefinedPlatformFeature = IDefinedPlatformFeature<TMethods, TEvents>;

export function definePlatformFeature<const M extends TMethods, const E extends TEvents>(
    definition: IFeatureInput<M, E>,
) {
    type TFeature = IDefinedPlatformFeature<M, E>;
    const events = definition.events ?? {} as E;
    const seen = new Set<string>();
    const invokeChannels: Record<string, string> = {};
    const eventChannels: Record<string, string> = {};
    const ipcCodecs: Record<string, {
        encodeArgs: (value: unknown[]) => unknown[];
        decodeArgs: (value: readonly unknown[]) => unknown[];
        decodeResult: (value: unknown) => unknown;
    }> = {};
    const methods: IPlatformMethodDescriptor[] = [];
    const fixtureMethods: Array<TFeature['fixtureMethods'][number]> = [];
    const addChannel = (channel: string) => {
        if (seen.has(channel)) {
            fail(`Duplicate platform feature channel: ${channel}`);
        }
        seen.add(channel);
    };
    const addDescriptor = (
        name: string,
        spec: {
            kind: IPlatformMethodDescriptor['kind'];
            lazy: 'forwarded' | 'direct';
        },
        required: Record<TPlatformBackend, boolean>,
        example: () => unknown,
        optionalWhenImplemented = false,
    ) => {
        const descriptor: IPlatformMethodDescriptor = {
            path: [
                ...definition.path,
                name,
            ],
            kind: spec.kind,
            required,
            ...(optionalWhenImplemented ? {optionalWhenImplemented: true} : {}),
            browserLazy: spec.lazy,
        };
        methods.push(descriptor);
        fixtureMethods.push({
            descriptor,
            example,
        });
    };
    for (const [
        name,
        spec,
    ] of Object.entries(definition.methods)) {
        if (spec.kind === 'sync' || 'local' in spec) {
            addDescriptor(name, spec, {
                ...definition.required,
                ...spec.required,
            }, spec.kind === 'sync'
                ? spec.result.example
                : spec.local.result.example, spec.optionalWhenImplemented);
            continue;
        }
        addChannel(spec.channel);
        invokeChannels[name] = spec.channel;
        ipcCodecs[spec.channel] = {
            encodeArgs: value => spec.ipc.args.encode(value) as unknown[],
            decodeArgs: value => spec.ipc.args.decode(value),
            decodeResult: spec.ipc.result.decode,
        };
        addDescriptor(name, spec, {
            ...definition.required,
            ...spec.required,
        }, spec.ipc.result.example, spec.optionalWhenImplemented);
    }
    for (const [
        name,
        spec,
    ] of Object.entries(events)) {
        addChannel(spec.channel);
        eventChannels[name] = spec.channel;
        addDescriptor(name, spec, definition.required, () => () => undefined);
        if (spec.subscription) {
            addChannel(spec.subscription.channel);
            invokeChannels[spec.subscription.main.method] = spec.subscription.channel;
            const noArgs = runtimeSchema.tuple([]);
            ipcCodecs[spec.subscription.channel] = {
                encodeArgs: value => noArgs.encode(value as []) as unknown[],
                decodeArgs: noArgs.decode,
                decodeResult: runtimeSchema.undefined().decode,
            };
        }
    }
    return {
        ...definition,
        events,
        platformDescriptors: {
            capabilities: [{
                path: definition.capabilityPath ?? definition.path,
                required: definition.required,
                ...(definition.manifestPath ? {manifestPath: definition.manifestPath} : {}),
            }],
            methods,
        },
        invokeChannels: invokeChannels as TFeature['invokeChannels'],
        invokeChannelSet: new Set(Object.values(invokeChannels)),
        eventChannels: eventChannels as TFeature['eventChannels'],
        ipcCodecs: Object.assign({} as TFeature['ipcCodecs'], ipcCodecs),
        fixtureMethods,
    } satisfies TFeature;
}
