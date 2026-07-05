import type {
    IpcMainEvent,
    IpcMainInvokeEvent,
} from 'electron';
import type {
    IIpcInvokeSpec,
    IIpcMainRegistrar,
} from '@contracts/ipcMain';
import {
    isTrustedIpcInvokeSender,
    isTrustedWebContentsSender,
} from '@electron/platform-ipc/trustedIpcSender';

const registeredInvokeChannels = new Set<string>();
const registeredEventChannels = new Set<string>();

class IpcArgumentValidationError extends Error {
    readonly code = 'IPC_INVALID_ARGUMENTS';
    readonly channel: string;
    override readonly cause?: unknown;

    constructor(channel: string, message: string, cause?: unknown) {
        super(`Invalid IPC arguments for ${channel}: ${message}`);
        this.name = 'IpcArgumentValidationError';
        this.channel = channel;
        this.cause = cause;
    }
}

export interface IIpcMainDecodeOptions<TArgs extends unknown[]> {decode: (args: unknown[], channel: string) => TArgs;}

export interface IIpcInvokeArgumentValidationPolicy {
    noArgumentChannels?: ReadonlySet<string>;
    channelsValidatedWithoutRegistrarDecoder?: ReadonlySet<string>;
}

export interface IValidatedIpcMainRegistrarOptions {
    allowedChannels?: ReadonlySet<string>;
    argumentValidation?: IIpcInvokeArgumentValidationPolicy;
}

export interface IValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec} = never,
    TEvent = unknown,
> {handle: [TMap] extends [never]
    ? <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: TEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
        options?: IIpcMainDecodeOptions<TArgs>,
    ) => void
    : <TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        handler: (
            event: TEvent,
            ...args: TMap[TChannel]['args']
        ) => TMap[TChannel]['result'] | Promise<TMap[TChannel]['result']>,
        options?: IIpcMainDecodeOptions<TMap[TChannel]['args']>,
    ) => void;}

export function createChannelSet<T extends Record<string, string>>(channels: T) {
    return new Set<string>(Object.values(channels));
}

function assertAllowedChannelRegistration(
    kind: 'invoke' | 'event',
    channel: string,
    allowedChannels?: ReadonlySet<string>,
) {
    if (allowedChannels && !allowedChannels.has(channel)) {
        throw new Error(`Unknown ${kind} IPC channel registered: ${channel}`);
    }
}

function assertUniqueChannelRegistration(
    kind: 'invoke' | 'event',
    registeredChannels: Set<string>,
    channel: string,
) {
    if (registeredChannels.has(channel)) {
        throw new Error(`Duplicate ${kind} IPC channel registration: ${channel}`);
    }
    registeredChannels.add(channel);
}

function assertKnownChannelRegistration(
    kind: 'invoke' | 'event',
    registeredChannels: Set<string>,
    channel: string,
    allowedChannels?: ReadonlySet<string>,
) {
    assertAllowedChannelRegistration(kind, channel, allowedChannels);
    assertUniqueChannelRegistration(kind, registeredChannels, channel);
}

function getDecodeErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function getPolicyChannels(policy: IIpcInvokeArgumentValidationPolicy | undefined) {
    return [
        ...(policy?.noArgumentChannels ?? []),
        ...(policy?.channelsValidatedWithoutRegistrarDecoder ?? []),
    ];
}

function assertArgumentValidationPolicyChannelsAreKnown(options: IValidatedIpcMainRegistrarOptions) {
    if (!options.allowedChannels) {
        return;
    }

    for (const channel of getPolicyChannels(options.argumentValidation)) {
        if (!options.allowedChannels.has(channel)) {
            throw new Error(`IPC argument validation policy contains unknown invoke channel: ${channel}`);
        }
    }
}

function getArgumentValidationBypassKind(
    channel: string,
    policy: IIpcInvokeArgumentValidationPolicy | undefined,
) {
    if (policy?.noArgumentChannels?.has(channel)) {
        return 'no-arguments';
    }
    if (policy?.channelsValidatedWithoutRegistrarDecoder?.has(channel)) {
        return 'validated-without-registrar-decoder';
    }
    return null;
}

export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: IValidatedIpcMainRegistrarOptions,
): IValidatedIpcMainRegistrar<never, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
>(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: IValidatedIpcMainRegistrarOptions,
): IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options: IValidatedIpcMainRegistrarOptions = {},
): IValidatedIpcMainRegistrar<never, IpcMainInvokeEvent> {
    assertArgumentValidationPolicyChannelsAreKnown(options);
    return {handle: <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: IpcMainInvokeEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
        decodeOptions?: IIpcMainDecodeOptions<TArgs>,
    ) => {
        assertAllowedChannelRegistration('invoke', channel, options.allowedChannels);
        const hasDecoder = typeof decodeOptions?.decode === 'function';
        const argumentValidationBypassKind = hasDecoder
            ? null
            : getArgumentValidationBypassKind(channel, options.argumentValidation);
        if (!hasDecoder && !argumentValidationBypassKind) {
            throw new Error(`IPC invoke channel registered without an argument decoder or explicit no-arg/validated allowlist: ${channel}`);
        }
        assertUniqueChannelRegistration('invoke', registeredInvokeChannels, channel);
        registrar.handle(channel, async (event, ...args: unknown[]) => {
            if (!isTrustedIpcInvokeSender(event, channel)) {
                throw new Error('IPC sender is not trusted');
            }
            let decodedArgs: TArgs;
            try {
                if (argumentValidationBypassKind === 'no-arguments') {
                    if (args.length > 0) {
                        throw new Error('expected no arguments');
                    }
                    const noArgs: unknown[] = [];
                    decodedArgs = noArgs as TArgs;
                } else {
                    decodedArgs = decodeOptions?.decode
                        ? decodeOptions.decode(args, channel)
                        : args as TArgs;
                }
            } catch (error) {
                throw new IpcArgumentValidationError(channel, getDecodeErrorMessage(error), error);
            }
            return handler(event, ...decodedArgs);
        });
    }};
}

export interface IValidatedIpcMainEventRegistrar {on: (
    channel: string,
    handler: (event: IpcMainEvent, ...args: unknown[]) => void,
) => void;}

interface IValidatedIpcMainEventSource {on: (
    channel: string,
    handler: (event: IpcMainEvent, ...args: unknown[]) => void,
) => void;}

export function createValidatedIpcMainEventRegistrar(
    registrar: IValidatedIpcMainEventSource,
    options: {allowedChannels?: ReadonlySet<string>;} = {},
): IValidatedIpcMainEventRegistrar {
    return {on: (channel, handler) => {
        assertKnownChannelRegistration('event', registeredEventChannels, channel, options.allowedChannels);
        registrar.on(channel, (event, ...args: unknown[]) => {
            if (!isTrustedWebContentsSender(event.sender, event.senderFrame, channel)) {
                return;
            }
            handler(event, ...args);
        });
    }};
}
