import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
import { cast } from '@tests/helpers/cast';

const WINDOW_TABS_CHANNEL = 'evb-viewer:browserWindowTabs';

type TChannelListener = (event: MessageEvent<unknown>) => void;

class MockBroadcastChannel {
    public static readonly channels = new Set<MockBroadcastChannel>();

    private readonly listeners = new Set<TChannelListener>();
    private closed = false;

    public constructor(public readonly name: string) {
        MockBroadcastChannel.channels.add(this);
    }

    public addEventListener(type: string, listener: TChannelListener) {
        if (type === 'message') {
            this.listeners.add(listener);
        }
    }

    public removeEventListener(type: string, listener: TChannelListener) {
        if (type === 'message') {
            this.listeners.delete(listener);
        }
    }

    public postMessage(data: unknown) {
        for (const channel of MockBroadcastChannel.channels) {
            if (channel === this || channel.name !== this.name || channel.closed) {
                continue;
            }

            channel.dispatch(data);
        }
    }

    public close() {
        this.closed = true;
        this.listeners.clear();
        MockBroadcastChannel.channels.delete(this);
    }

    public static reset() {
        for (const channel of Array.from(MockBroadcastChannel.channels)) {
            channel.close();
        }
        MockBroadcastChannel.channels.clear();
    }

    private dispatch(data: unknown) {
        const event = cast<MessageEvent<unknown>>({ data });
        for (const listener of Array.from(this.listeners)) {
            listener(event);
        }
    }
}

function stubBrowserGlobals(href = 'http://localhost:3235/') {
    const windowListeners = new Map<string, Set<EventListener>>();
    const windowStub = {
        location: { href },
        history: {
            state: null,
            replaceState: vi.fn((_state: unknown, _title: string, url?: string | URL | null) => {
                if (!url) {
                    return;
                }

                windowStub.location.href = url.toString();
            }),
        },
        setTimeout,
        clearTimeout,
        addEventListener: vi.fn((type: string, listener: EventListener) => {
            const listeners = windowListeners.get(type) ?? new Set<EventListener>();
            listeners.add(listener);
            windowListeners.set(type, listeners);
        }),
        removeEventListener: vi.fn((type: string, listener: EventListener) => {
            windowListeners.get(type)?.delete(listener);
        }),
        open: vi.fn(() => null),
    };

    vi.stubGlobal('window', cast<Window>(windowStub));
    vi.stubGlobal('document', { title: 'EVB Viewer Web' });
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    return windowStub;
}

async function resolveTargetWindows(
    capability: IWindowTabsCapability,
) {
    const targets = capability.listTargetWindows();
    await vi.advanceTimersByTimeAsync(70);
    return targets;
}

describe('browserWindowTabsCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.useFakeTimers();
        MockBroadcastChannel.reset();
        stubBrowserGlobals();
    });

    afterEach(() => {
        MockBroadcastChannel.reset();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('lists live target windows that answer discovery', async () => {
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        externalWindow.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'discover') {
                return;
            }

            externalWindow.postMessage({
                type: 'announce',
                windowId: 200,
                label: 'Other PDF',
                ready: true,
            });
        });

        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();

        await expect(resolveTargetWindows(browserWindowTabsCapability)).resolves.toEqual([{
            windowId: 200,
            label: 'Other PDF',
        }]);
    });

    it('prunes target windows that no longer answer discovery', async () => {
        let shouldRespond = true;
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        externalWindow.addEventListener('message', (event) => {
            const data = event.data;
            if (
                !shouldRespond
                || !data
                || typeof data !== 'object'
                || !('type' in data)
                || data.type !== 'discover'
            ) {
                return;
            }

            externalWindow.postMessage({
                type: 'announce',
                windowId: 201,
                label: 'Closing PDF',
                ready: true,
            });
        });

        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();

        await expect(resolveTargetWindows(browserWindowTabsCapability)).resolves.toEqual([{
            windowId: 201,
            label: 'Closing PDF',
        }]);

        shouldRespond = false;

        await expect(resolveTargetWindows(browserWindowTabsCapability)).resolves.toEqual([]);
    });

    it('does not list a previous hot-reloaded instance from the same browser tab', async () => {
        const firstModule = await import('@app/platform/browserWindowTabs');
        firstModule.browserWindowTabsCapability.notifyRendererReady();

        vi.resetModules();

        const secondModule = await import('@app/platform/browserWindowTabs');
        secondModule.browserWindowTabsCapability.notifyRendererReady();

        await expect(resolveTargetWindows(secondModule.browserWindowTabsCapability)).resolves.toEqual([]);
        expect(MockBroadcastChannel.channels).toHaveLength(1);
    });

    it('delegates incoming transfer decoding to the canonical contract decoder', async () => {
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        const callback = vi.fn();
        browserWindowTabsCapability.onIncomingTransfer(callback);
        browserWindowTabsCapability.notifyRendererReady();

        const baseTransfer = {
            schemaVersion: 1,
            nonce: 'nonce-1',
            transferId: 'transfer-1',
            sourceWindowId: 200,
            targetWindowId: 100,
            tab: {
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                isDirty: false,
                isDjvu: false,
                ignored: 'drop-me',
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                snapshotPath: '/tmp/snapshot.pdf',
                snapshotBackend: 'electron',
                isDirty: false,
                currentPage: 2,
                totalPages: 3,
                ignored: 'drop-me',
            },
            ignored: 'drop-me',
        };

        externalWindow.postMessage({
            type: 'transfer',
            transfer: baseTransfer,
        });

        expect(callback).toHaveBeenCalledWith({
            schemaVersion: 1,
            nonce: 'nonce-1',
            transferId: 'transfer-1',
            sourceWindowId: 200,
            targetWindowId: 100,
            tab: {
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                isDirty: false,
                isDjvu: false,
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                snapshotPath: '/tmp/snapshot.pdf',
                snapshotBackend: 'electron',
                isDirty: false,
                currentPage: 2,
                totalPages: 3,
            },
        });

        callback.mockClear();
        externalWindow.postMessage({
            type: 'transfer',
            transfer: {
                ...baseTransfer,
                transferId: 'transfer-2',
                tab: {
                    ...baseTransfer.tab,
                    originalBackend: 'bogus',
                },
            },
        });
        expect(callback).not.toHaveBeenCalled();
    });
});
