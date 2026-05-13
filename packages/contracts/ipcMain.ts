import type { IpcMainInvokeEvent } from 'electron';

export type TIpcMainInvokeHandler<
    TArgs extends unknown[] = unknown[],
    TResult = unknown,
> = (
    event: IpcMainInvokeEvent,
    ...args: TArgs
) => TResult | Promise<TResult>;

export interface IIpcMainRegistrar {handle: <TArgs extends unknown[], TResult>(
    channel: string,
    handler: TIpcMainInvokeHandler<TArgs, TResult>,
) => void;}
