import { BrowserWindow } from 'electron';
import { OCR_EVENT_CHANNELS } from '@electron/features/ocr/contract';
import { toScopedOcrJobId } from '@electron/ocr/jobManagerProtocol';
import type {
    IOcrPreparingJob,
    IOcrQueuedJob,
} from '@electron/ocr/jobManager.types';
import type {
    IOcrProgress,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';
import { createLogger } from '@electron/utils/createLogger';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { getErrorMessage } from '@electron/utils/error';
import { sendToLiveWindow } from '@electron/utils/sendToLiveWindow';

const log = createLogger('ocr-ipc');

const progressPumpsBySenderId = new Map<number, ReturnType<typeof createIpcProgressPump<IOcrProgress>>>();

export function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: typeof OCR_EVENT_CHANNELS[keyof typeof OCR_EVENT_CHANNELS],
    ...args: unknown[]
) {
    sendToLiveWindow(window, channel, args, (err: unknown) => {
        log.debug(`Failed to send IPC message to channel "${channel}": ${getErrorMessage(err)}`);
    });
}

function getSenderIdFromScopedJobId(scopedJobId: string) {
    const separatorIndex = scopedJobId.indexOf(':');
    if (separatorIndex <= 0) {
        return null;
    }
    const senderId = Number.parseInt(scopedJobId.slice(0, separatorIndex), 10);
    return Number.isSafeInteger(senderId) && senderId > 0 ? senderId : null;
}

export function getJobWindow(webContentsId: number) {
    return BrowserWindow.getAllWindows().find(
        window => window.webContents.id === webContentsId,
    );
}

function getOcrProgressPump(senderId: number) {
    let pump = progressPumpsBySenderId.get(senderId);
    if (pump) {
        return pump;
    }

    pump = createIpcProgressPump<IOcrProgress>({
        channel: OCR_EVENT_CHANNELS.progress,
        getTarget: () => {
            const window = getJobWindow(senderId);
            return {
                key: `web-contents:${senderId}`,
                isDestroyed: () => !window
                    || window.isDestroyed?.() === true
                    || window.webContents.isDestroyed?.() === true,
                send: (_channel: string, payload: IOcrProgress) => safeSendToWindow(
                    window,
                    OCR_EVENT_CHANNELS.progress,
                    payload,
                ),
            };
        },
        getKey: (payload: IOcrProgress) => payload.requestId,
        isTerminal: (payload: IOcrProgress) => payload.status === 'success'
            || payload.status === 'canceled'
            || payload.status === 'failed'
            || (
                payload.phase === 'indexing'
                && payload.totalPages > 0
                && payload.processedCount >= payload.totalPages
            ),
        onError: (error: unknown) => {
            log.debug(`Failed to send OCR progress: ${getErrorMessage(error)}`);
        },
        onIdle: () => {
            progressPumpsBySenderId.delete(senderId);
        },
    });
    progressPumpsBySenderId.set(senderId, pump);
    return pump;
}

export function subscribeManagedOcrProgress(senderId: number, target: {
    key?: string;
    isDestroyed?: () => boolean;
    send: (channel: string, payload: IOcrProgress) => void;
}) {
    progressPumpsBySenderId.get(senderId)?.subscribe(target);
}

export function enqueueOcrProgress(
    scopedJobId: string,
    progress: IOcrProgress,
) {
    const senderId = getSenderIdFromScopedJobId(scopedJobId);
    if (senderId === null) {
        return;
    }
    getOcrProgressPump(senderId).enqueue(progress);
}

export function enqueueTerminalOcrProgress(
    job: Pick<IOcrQueuedJob | IOcrPreparingJob, 'scopedJobId' | 'requestId'>,
    status: 'success' | 'canceled' | 'failed',
    error?: string,
) {
    const totalPages = 'pages' in job && Array.isArray(job.pages)
        ? job.pages.length
        : 0;
    enqueueOcrProgress(job.scopedJobId, {
        requestId: job.requestId,
        currentPage: 0,
        processedCount: status === 'success' ? totalPages : 0,
        totalPages,
        status,
        ...(error === undefined ? {} : {error}),
    });
}

export function clearOcrProgressPump(scopedJobId: string, requestId?: string) {
    const senderId = getSenderIdFromScopedJobId(scopedJobId);
    if (senderId === null) {
        return;
    }
    const pump = progressPumpsBySenderId.get(senderId);
    if (!pump) {
        return;
    }
    if (requestId) {
        pump.flush(requestId);
        pump.clearKey(requestId);
        return;
    }
    pump.clear();
}

export function sendOcrProgressStage(
    webContentsId: number,
    requestId: string,
    pages: IOcrPdfPageRequest[],
    phase: TOcrProgressPhase,
    phaseProgress?: number,
) {
    enqueueOcrProgress(toScopedOcrJobId(webContentsId, requestId), {
        requestId,
        currentPage: pages[0]?.pageNumber ?? 0,
        processedCount: 0,
        totalPages: pages.length,
        phase,
        ...(phaseProgress !== undefined ? { phaseProgress } : {}),
    });
}
