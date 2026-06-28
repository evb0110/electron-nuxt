import type { Event } from 'electron';

type TOcrSenderNavigationListener = (
    event: Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
) => void;
type TOcrSenderLifecycleListener = () => void;

interface IOcrJobOperationSender {
    isDestroyed: () => boolean;
    once: (event: 'destroyed' | 'render-process-gone', listener: TOcrSenderLifecycleListener) => unknown;
    on: (event: 'did-start-navigation', listener: TOcrSenderNavigationListener) => unknown;
    removeListener: (
        event: 'destroyed' | 'render-process-gone' | 'did-start-navigation',
        listener: TOcrSenderLifecycleListener | TOcrSenderNavigationListener,
    ) => unknown;
}

export interface IOcrJobOperationContext {
    sender: IOcrJobOperationSender;
    senderId: number;
}
