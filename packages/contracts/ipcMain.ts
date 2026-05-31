import type { IpcMainInvokeEvent } from 'electron';

export interface IIpcInvokeSpec<TArgs extends unknown[] = unknown[], TResult = unknown> {
    args: TArgs;
    result: TResult;
}

export type TIpcMainInvokeHandler<
    TArgs extends unknown[] = unknown[],
    TResult = unknown,
> = (
    event: IpcMainInvokeEvent,
    ...args: TArgs
) => TResult | Promise<TResult>;

export type TUntypedIpcMainHandle = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: TIpcMainInvokeHandler<TArgs, TResult>,
) => void;

export type TTypedIpcMainHandle<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
> = <TChannel extends Extract<keyof TMap, string>>(
    channel: TChannel,
    handler: TIpcMainInvokeHandler<TMap[TChannel]['args'], TMap[TChannel]['result']>,
) => void;

export interface IIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec} = never,
> {handle: [TMap] extends [never] ? TUntypedIpcMainHandle : TTypedIpcMainHandle<TMap>;}
