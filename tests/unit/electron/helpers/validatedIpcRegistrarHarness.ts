import type {IpcMainInvokeEvent} from 'electron';
import type {
    IIpcInvokeSpec,
    IIpcMainRegistrar,
    TIpcCodecMap,
} from '@contracts/ipcMain';
import {
    createChannelSet,
    createValidatedIpcMainRegistrar,
    type IValidatedIpcMainRegistrarOptions,
    type IValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';

export type TCapturedIpcHandler = (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
) => unknown;

export interface IValidatedRegistrarCase {
    channel: string;
    validArgs: unknown[];
}

export function createValidatedRegistrarHarness<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
    TService,
>(options: {
    channels: Record<string, string>;
    codecs: TIpcCodecMap<TMap>;
    register: (registrar: IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>, service: TService) => void;
    service: TService;
}) {
    const handlers = new Map<string, TCapturedIpcHandler>();
    const nativeRegistrar: IIpcMainRegistrar<never, IpcMainInvokeEvent> = {handle: ((
        channel: string,
        handler: TCapturedIpcHandler,
    ) => {
        handlers.set(channel, handler);
    }) as IIpcMainRegistrar<never, IpcMainInvokeEvent>['handle']};
    const allowedChannels = createChannelSet(options.channels);
    const registrarOptions: IValidatedIpcMainRegistrarOptions<TMap> = {
        allowedChannels,
        codecs: options.codecs,
    };
    const registrar = createValidatedIpcMainRegistrar<TMap>(nativeRegistrar, registrarOptions);
    options.register(registrar, options.service);
    return handlers;
}

export function getCapturedIpcHandler(
    handlers: ReadonlyMap<string, TCapturedIpcHandler>,
    channel: string,
) {
    const handler = handlers.get(channel);
    if (handler === undefined) {
        throw new Error(`Expected a registered IPC handler for ${channel}`);
    }
    return handler;
}

export function createHarnessEvent(senderId = 7) {
    return {sender: {id: senderId}} as IpcMainInvokeEvent;
}
