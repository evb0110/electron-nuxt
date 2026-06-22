import { EventEmitter } from 'events';
import type {
    BrowserWindow,
    IpcMainInvokeEvent,
} from 'electron';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
} from '@contracts/agent';
import { cast } from '@tests/helpers/cast';
import type * as AgentWorkspaceBridgeModule from '@electron/features/agent/workspaceBridge';

const mocks = vi.hoisted(() => ({fromWebContents: vi.fn()}));

vi.mock('electron', () => ({BrowserWindow: {fromWebContents: mocks.fromWebContents}}));

const {
    requestAgentCommand,
    requestAgentWorkspaceSnapshot,
    submitAgentWorkspaceSnapshotResponse,
}: typeof AgentWorkspaceBridgeModule = await import('@electron/features/agent/workspaceBridge');

interface IFakeWebContents extends EventEmitter {
    isDestroyed: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
}

interface IFakeWindow extends EventEmitter {
    id: number;
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: IFakeWebContents;
}

function createFakeWindow(id = 101): IFakeWindow {
    const webContents: IFakeWebContents = Object.assign(new EventEmitter(), {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
    });

    const window: IFakeWindow = Object.assign(new EventEmitter(), {
        id,
        isDestroyed: vi.fn(() => false),
        webContents,
    });
    return window;
}

function toBrowserWindow(window: IFakeWindow) {
    return cast<BrowserWindow>(window);
}

function createResponseEvent(window: IFakeWindow) {
    return cast<IpcMainInvokeEvent>({sender: window.webContents});
}

function isSnapshotRequest(value: unknown): value is IAgentWorkspaceSnapshotRequest & {windowId: number} {
    return typeof value === 'object'
        && value !== null
        && 'requestId' in value
        && typeof value.requestId === 'string'
        && 'windowId' in value
        && typeof value.windowId === 'number'
        && (
            !('lastSeenRevision' in value)
            || value.lastSeenRevision === undefined
            || typeof value.lastSeenRevision === 'number'
        );
}

function getSnapshotRequest(window: IFakeWindow, index = 0) {
    const sendCalls: ReadonlyArray<readonly unknown[]> = window.webContents.send.mock.calls;
    const request: unknown = sendCalls[index]?.[1];
    if (!isSnapshotRequest(request)) {
        throw new Error(`Expected snapshot request at send call ${index}`);
    }
    return request;
}

describe('agent workspace bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects pending snapshot requests when the target window closes', async () => {
        const window = createFakeWindow();

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        window.emit('closed');

        await expect(pending).rejects.toThrow('target window closed');
    });

    it('rejects pending command requests when the target renderer exits', async () => {
        const window = createFakeWindow();

        const pending = requestAgentCommand(toBrowserWindow(window), {
            name: 'activate_tab',
            arguments: {tabId: 'tab-1'},
        }, 30_000);
        window.webContents.emit('render-process-gone');

        await expect(pending).rejects.toThrow('target window renderer exited');
    });

    it('rejects pending snapshot requests on main-frame navigation only', async () => {
        const window = createFakeWindow();

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        window.webContents.emit('did-start-navigation', {}, 'app://subframe', false, false);
        expect(window.webContents.send).toHaveBeenCalledOnce();

        window.webContents.emit('did-start-navigation', {}, 'app://reload', false, true);

        await expect(pending).rejects.toThrow('target window navigated');
    });

    it('cleans lifecycle listeners after accepting a snapshot response', async () => {
        const window = createFakeWindow(202);
        mocks.fromWebContents.mockReturnValue(window);

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const request = getSnapshotRequest(window);

        const accepted = submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: request.requestId,
                windowId: request.windowId,
                ok: true,
                snapshot: { tabs: [] },
            },
        );

        expect(accepted).toEqual({ accepted: true });
        await expect(pending).resolves.toEqual({ tabs: [] });
        expect(window.listenerCount('closed')).toBe(0);
        expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
        expect(window.webContents.listenerCount('did-start-navigation')).toBe(0);
    });

    it('resolves unchanged snapshot responses from the per-window cache', async () => {
        const window = createFakeWindow(404);
        mocks.fromWebContents.mockReturnValue(window);
        const snapshot: IAgentWorkspaceSnapshot = {
            capturedAt: '2026-06-22T00:00:00.000Z',
            activePaneId: null,
            activeTabId: null,
            summary: {
                mode: 'empty-workspace',
                activeDocument: null,
                documentCount: 0,
                recentFileCount: 0,
                recentFilesResolved: true,
            },
            panes: [],
            tabs: [],
            recentFiles: [],
            layout: null,
        };

        const firstPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const firstRequest = getSnapshotRequest(window);

        expect(firstRequest.lastSeenRevision).toBeUndefined();
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: firstRequest.requestId,
                windowId: firstRequest.windowId,
                ok: true,
                revision: 7,
                snapshot,
            },
        )).toEqual({ accepted: true });
        await expect(firstPending).resolves.toBe(snapshot);

        const secondPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const secondRequest = getSnapshotRequest(window, 1);

        expect(secondRequest.lastSeenRevision).toBe(7);
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: secondRequest.requestId,
                windowId: secondRequest.windowId,
                ok: true,
                revision: 7,
                unchanged: true,
            },
        )).toEqual({ accepted: true });
        await expect(secondPending).resolves.toBe(snapshot);
    });

    it('rejects unchanged snapshot responses when no cache exists', async () => {
        const window = createFakeWindow(505);
        mocks.fromWebContents.mockReturnValue(window);

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const request = getSnapshotRequest(window);

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: request.requestId,
                windowId: request.windowId,
                ok: true,
                revision: 1,
                unchanged: true,
            },
        )).toEqual({ accepted: true });

        await expect(pending).rejects.toThrow('no cached snapshot is available');
    });

    it('returns actionable acknowledgements for invalid and stale snapshot responses', () => {
        const window = createFakeWindow(303);
        mocks.fromWebContents.mockReturnValue(window);

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: '',
                ok: true,
            },
        )).toEqual({
            accepted: false,
            reason: 'invalid-payload',
        });

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: 'missing-request',
                ok: false,
            },
        )).toEqual({
            accepted: false,
            reason: 'unknown-request',
        });
    });
});
