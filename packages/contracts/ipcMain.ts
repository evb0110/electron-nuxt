export interface IIpcInvokeSpec<TArgs extends unknown[] = unknown[], TResult = unknown> {
    args: TArgs;
    result: TResult;
}

export type TIpcMainInvokeHandler<
    TArgs extends unknown[] = unknown[],
    TResult = unknown,
    TEvent = unknown,
> = (
    event: TEvent,
    ...args: TArgs
) => TResult | Promise<TResult>;

export type TUntypedIpcMainHandle<TEvent = unknown> = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: TIpcMainInvokeHandler<TArgs, TResult, TEvent>,
) => void;

export type TTypedIpcMainHandle<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
    TEvent = unknown,
> = <TChannel extends Extract<keyof TMap, string>>(
    channel: TChannel,
    handler: TIpcMainInvokeHandler<TMap[TChannel]['args'], TMap[TChannel]['result'], TEvent>,
) => void;

export interface IIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec} = never,
    TEvent = unknown,
> {handle: [TMap] extends [never] ? TUntypedIpcMainHandle<TEvent> : TTypedIpcMainHandle<TMap, TEvent>;}
