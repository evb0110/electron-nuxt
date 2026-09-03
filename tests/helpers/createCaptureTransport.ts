/* eslint-disable @typescript-eslint/naming-convention */

export interface CaptureTransport<TEvent> {
    readonly events: TEvent[];
    send(event: TEvent): void;
    capture(event: TEvent): void;
    clear(): void;
}

export function createCaptureTransport<TEvent>(): CaptureTransport<TEvent> {
    const events: TEvent[] = [];
    const send = (event: TEvent) => {
        events.push(event);
    };
    return {
        events,
        send,
        capture: send,
        clear: () => {
            events.length = 0;
        },
    };
}
