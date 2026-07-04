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

function assertKnownChannelRegistration(
    kind: 'invoke' | 'event',
    registeredChannels: Set<string>,
    channel: string,
    allowedChannels?: ReadonlySet<string>,
) {
    if (allowedChannels && !allowedChannels.has(channel)) {
        throw new Error(`Unknown ${kind} IPC channel registered: ${channel}`);
    }
    if (registeredChannels.has(channel)) {
        throw new Error(`Duplicate ${kind} IPC channel registration: ${channel}`);
    }
    registeredChannels.add(channel);
}

function getDecodeErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: {allowedChannels?: ReadonlySet<string>;},
): IValidatedIpcMainRegistrar<never, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
>(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: {allowedChannels?: ReadonlySet<string>;},
): IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options: {allowedChannels?: ReadonlySet<string>;} = {},
): IValidatedIpcMainRegistrar<never, IpcMainInvokeEvent> {
    return {handle: <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: IpcMainInvokeEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
        decodeOptions?: IIpcMainDecodeOptions<TArgs>,
    ) => {
        assertKnownChannelRegistration('invoke', registeredInvokeChannels, channel, options.allowedChannels);
        registrar.handle(channel, async (event, ...args: unknown[]) => {
            if (!isTrustedIpcInvokeSender(event, channel)) {
                throw new Error('IPC sender is not trusted');
            }
            let decodedArgs: TArgs;
            try {
                decodedArgs = decodeOptions?.decode
                    ? decodeOptions.decode(args, channel)
                    : args as TArgs;
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
