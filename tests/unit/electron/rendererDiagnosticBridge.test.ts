import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { DiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import type { DiagnosticEventId } from '@contracts/diagnostics/diagnosticEventId';
import {CORE_IPC_SEND_CHANNELS} from '@electron/platform-ipc/coreContract';
import { registerRendererDiagnosticBridge } from '@electron/platform-ipc/rendererDiagnosticBridge';

const record: DiagnosticRecord<'UNCLASSIFIED_RENDERER_ERROR'> = {
    schemaVersion: 1,
    eventId: 'a'.repeat(32) as DiagnosticEventId,
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    severity: 'error',
    runtime: 'electron-renderer',
    operation: 'renderer-error',
    occurredAt: 1_757_000_000_000,
    frames: [{
        module: 'app/utils/failureReporter.ts',
        function: 'capture',
        line: 1,
        column: 1,
    }],
    context: {phase: 'operation'},
};

function createEvent(senderId = 7) {
    const sender = {
        id: senderId,
        once: vi.fn(),
        removeListener: vi.fn(),
    };
    return {
        event: {
            sender,
            senderFrame: null,
        } as never,
        sender,
    };
}

describe('renderer diagnostic bridge', () => {
    it('accepts only trusted closed renderer records and never broadcasts a debug log', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        const bridge = registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: vi.fn(() => true),
            registerListener: (channel, handler) => {
                expect(channel).toBe(CORE_IPC_SEND_CHANNELS.rendererDiagnostic);
                listener = handler;
            },
        });
        const {event} = createEvent();
        listener?.(event, record);

        expect(captureRecord).toHaveBeenCalledWith(record);
        expect(bridge.getHealthSnapshot()).toEqual({
            accepted: 1,
            rateDropped: 0,
            schemaDropped: 0,
            untrustedDropped: 0,
        });
    });

    it('counts untrusted, oversized, malformed, unknown-code, and unknown-context records as rejected', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        const trusted = vi.fn((sender: {id: number}) => sender.id !== 1);
        const bridge = registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: trusted as never,
            rateBurst: 10,
            registerListener: (_channel, handler) => { listener = handler; },
        });
        listener?.(createEvent(1).event, record);
        listener?.(createEvent(2).event, {
            ...record,
            padding: 'x'.repeat(20_000),
        });
        listener?.(createEvent(3).event, {
            ...record,
            code: 'UNKNOWN_CODE',
        });
        listener?.(createEvent(4).event, {
            ...record,
            context: {unknown: true},
        });

        expect(captureRecord).not.toHaveBeenCalled();
        expect(bridge.getHealthSnapshot()).toEqual({
            accepted: 0,
            rateDropped: 0,
            schemaDropped: 3,
            untrustedDropped: 1,
        });
    });

    it('rate-limits each sender independently and cleans up the sender state', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        const bridge = registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: () => true,
            now: () => 1_000,
            rateBurst: 1,
            ratePerSecond: 1,
            registerListener: (_channel, handler) => { listener = handler; },
        });
        const first = createEvent(7);
        listener?.(first.event, record);
        listener?.(first.event, record);
        listener?.(createEvent(8).event, record);

        expect(captureRecord).toHaveBeenCalledTimes(2);
        expect(bridge.getHealthSnapshot()).toEqual({
            accepted: 2,
            rateDropped: 1,
            schemaDropped: 0,
            untrustedDropped: 0,
        });
        expect(first.sender.once).toHaveBeenCalledTimes(2);
    });
});
