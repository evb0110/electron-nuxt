import type {
    THostToViewerMessage,
    TViewerToHostMessage,
} from '@evb/contracts/rn-webview-protocol';

export function encodeBridgeMessage(message: THostToViewerMessage) {
    return JSON.stringify(message);
}

export function parseViewerMessage(rawData: unknown): TViewerToHostMessage | null {
    if (typeof rawData !== 'string') {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(rawData);
        if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
            return null;
        }

        return parsed as TViewerToHostMessage;
    } catch {
        return null;
    }
}
