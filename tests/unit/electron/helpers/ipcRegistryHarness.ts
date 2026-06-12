export interface IRegisteredEvent {
    sender: unknown;
    senderFrame?: unknown;
}

export type TRegisteredHandler = (...args: unknown[]) => unknown;
