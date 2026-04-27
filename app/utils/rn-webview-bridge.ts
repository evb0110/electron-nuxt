import type {
    THostToViewerMessage,
    TViewerToHostMessage,
} from '@contracts/rn-webview-protocol';

interface IReactNativeWebViewBridge {postMessage(message: string): void;}

type TReactNativeWindow = Window & { ReactNativeWebView?: IReactNativeWebViewBridge };

function getReactNativeWindow() {
    return window as TReactNativeWindow;
}

function parseBridgeMessage(rawData: unknown): THostToViewerMessage | null {
    if (typeof rawData !== 'string') {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(rawData);
        if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
            return null;
        }
        return parsed as THostToViewerMessage;
    } catch {
        return null;
    }
}

export function isReactNativeWebViewHost() {
    return import.meta.client
        && typeof getReactNativeWindow().ReactNativeWebView?.postMessage === 'function';
}

export function postViewerMessage(message: TViewerToHostMessage) {
    if (!isReactNativeWebViewHost()) {
        return false;
    }

    getReactNativeWindow().ReactNativeWebView?.postMessage(JSON.stringify(message));
    return true;
}

export function subscribeToHostMessages(callback: (message: THostToViewerMessage) => void) {
    if (!import.meta.client) {
        return () => {};
    }

    const handleMessage = (event: MessageEvent) => {
        const message = parseBridgeMessage(event.data);
        if (message) {
            callback(message);
        }
    };

    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage as EventListener);

    return () => {
        window.removeEventListener('message', handleMessage);
        document.removeEventListener('message', handleMessage as EventListener);
    };
}

export function decodeBase64Bytes(base64: string) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
}
