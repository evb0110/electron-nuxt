import { ipcMain } from 'electron';
import type { DiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import { decodeDiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import { CORE_IPC_SEND_CHANNELS } from '@electron/platform-ipc/coreContract';

export const RENDERER_DIAGNOSTIC_MAX_PAYLOAD_BYTES = 16 * 1024;
export const RENDERER_DIAGNOSTIC_RATE_PER_SECOND = 20;
export const RENDERER_DIAGNOSTIC_RATE_BURST = 40;

export interface IRendererDiagnosticBridgeHealthSnapshot {
    accepted: number;
    rateDropped: number;
    schemaDropped: number;
    untrustedDropped: number;
}

export interface IRendererDiagnosticBridgeOptions {
    captureRecord: (record: DiagnosticRecord) => unknown;
    isTrustedSender: (
        sender: Electron.WebContents,
        senderFrame: Electron.WebFrameMain | null | undefined,
        channel: string,
    ) => boolean;
    now?: () => number;
    rateBurst?: number;
    ratePerSecond?: number;
    registerListener?: (
        channel: string,
        handler: (event: Electron.IpcMainEvent, payload: unknown) => void,
    ) => void;
}

interface IRateState {
    lastRefillAt: number;
    tokens: number;
}

function increment(value: number) {
    return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getPayloadBytes(value: unknown) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

export function registerRendererDiagnosticBridge(options: IRendererDiagnosticBridgeOptions) {
    const now = options.now ?? Date.now;
    const ratePerSecond = normalizePositiveInteger(options.ratePerSecond, RENDERER_DIAGNOSTIC_RATE_PER_SECOND);
    const rateBurst = normalizePositiveInteger(options.rateBurst, RENDERER_DIAGNOSTIC_RATE_BURST);
    const rateBySender = new Map<number, IRateState>();
    const cleanupRegistered = new Set<number>();
    const health: IRendererDiagnosticBridgeHealthSnapshot = {
        accepted: 0,
        rateDropped: 0,
        schemaDropped: 0,
        untrustedDropped: 0,
    };

    function consumeRateToken(senderId: number) {
        const currentTime = now();
        const state = rateBySender.get(senderId) ?? {
            lastRefillAt: currentTime,
            tokens: rateBurst,
        };
        const elapsedMs = Math.max(0, currentTime - state.lastRefillAt);
        state.tokens = Math.min(rateBurst, state.tokens + elapsedMs / 1_000 * ratePerSecond);
        state.lastRefillAt = currentTime;
        if (state.tokens < 1) {
            rateBySender.set(senderId, state);
            return false;
        }
        state.tokens -= 1;
        rateBySender.set(senderId, state);
        return true;
    }

    function registerCleanup(sender: Electron.WebContents) {
        if (cleanupRegistered.has(sender.id)) {
            return;
        }
        cleanupRegistered.add(sender.id);
        const cleanup = () => {
            rateBySender.delete(sender.id);
            cleanupRegistered.delete(sender.id);
            sender.removeListener('destroyed', cleanup);
            sender.removeListener('render-process-gone', cleanup);
        };
        sender.once('destroyed', cleanup);
        sender.once('render-process-gone', cleanup);
    }

    function handle(event: Electron.IpcMainEvent, payload: unknown) {
        if (!options.isTrustedSender(event.sender, event.senderFrame, CORE_IPC_SEND_CHANNELS.rendererDiagnostic)) {
            health.untrustedDropped = increment(health.untrustedDropped);
            return;
        }
        registerCleanup(event.sender);
        if (!consumeRateToken(event.sender.id)) {
            health.rateDropped = increment(health.rateDropped);
            return;
        }
        if (getPayloadBytes(payload) > RENDERER_DIAGNOSTIC_MAX_PAYLOAD_BYTES) {
            health.schemaDropped = increment(health.schemaDropped);
            return;
        }
        const record = decodeDiagnosticRecord(payload);
        if (record === null || record.runtime !== 'electron-renderer') {
            health.schemaDropped = increment(health.schemaDropped);
            return;
        }
        try {
            if (options.captureRecord(record) !== false) {
                health.accepted = increment(health.accepted);
            }
        } catch {
            // The bridge never lets reporting disturb the renderer sender.
        }
    }

    (options.registerListener ?? ((channel, handler) => ipcMain.on(channel, handler)))(
        CORE_IPC_SEND_CHANNELS.rendererDiagnostic,
        handle,
    );

    return {getHealthSnapshot: (): IRendererDiagnosticBridgeHealthSnapshot => Object.freeze({...health})};
}
