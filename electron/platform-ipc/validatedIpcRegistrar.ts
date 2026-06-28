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

export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: {allowedChannels?: ReadonlySet<string>;},
): IIpcMainRegistrar<never, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
>(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options?: {allowedChannels?: ReadonlySet<string>;},
): IIpcMainRegistrar<TMap, IpcMainInvokeEvent>;
export function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    options: {allowedChannels?: ReadonlySet<string>;} = {},
): IIpcMainRegistrar<never, IpcMainInvokeEvent> {
    return {handle: <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: IpcMainInvokeEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
    ) => {
        assertKnownChannelRegistration('invoke', registeredInvokeChannels, channel, options.allowedChannels);
        registrar.handle(channel, async (event, ...args: TArgs) => {
            if (!isTrustedIpcInvokeSender(event, channel)) {
                throw new Error('IPC sender is not trusted');
            }
            return handler(event, ...args);
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
