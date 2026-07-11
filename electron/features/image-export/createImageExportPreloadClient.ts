import type { IpcRenderer } from 'electron';
import type {
    IImageExportCapability,
    IImageExportProgress,
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    IMAGE_EXPORT_EVENT_CHANNELS,
    IMAGE_EXPORT_CHANNELS,
    type IImageExportEventMap,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/index';
import { IMAGE_EXPORT_IPC_CODECS } from '@electron/features/image-export/imageExportIpcCodecs';
import {
    createCodecIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';

const IMAGE_EXPORT_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
const IMAGE_EXPORT_INVOKE_TIMEOUT_MS_BY_CHANNEL = {
    [IMAGE_EXPORT_CHANNELS.exportImages]: IMAGE_EXPORT_NATIVE_IPC_TIMEOUT_MS,
    [IMAGE_EXPORT_CHANNELS.exportMultiPageTiff]: IMAGE_EXPORT_NATIVE_IPC_TIMEOUT_MS,
} as const;


function decodeImageExportProgress(payload: unknown): IImageExportProgress | null {
    if (
        !isRecord(payload)
        || typeof payload.requestId !== 'string'
        || (payload.format !== 'images' && payload.format !== 'multipage-tiff')
        || (payload.phase !== 'rendering' && payload.phase !== 'combining')
        || !isFiniteNumber(payload.processed)
        || !isFiniteNumber(payload.total)
        || !isFiniteNumber(payload.percent)
    ) {
        return null;
    }
    if (
        payload.status !== undefined
        && payload.status !== 'running'
        && payload.status !== 'success'
        && payload.status !== 'canceled'
        && payload.status !== 'failed'
    ) {
        return null;
    }
    if (payload.error !== undefined && typeof payload.error !== 'string') {
        return null;
    }

    return {
        requestId: payload.requestId,
        format: payload.format,
        phase: payload.phase,
        processed: payload.processed,
        total: payload.total,
        percent: payload.percent,
        ...(payload.status === undefined ? {} : {status: payload.status}),
        ...(payload.error === undefined ? {} : {error: payload.error}),
    };
}

export function createImageExportPreloadClient(
    ipcRenderer: IpcRenderer,
): IImageExportCapability {
    const invoke = createCodecIpcInvoker<IImageExportInvokeMap>(ipcRenderer, IMAGE_EXPORT_IPC_CODECS, {invokeTimeoutMsByChannel: IMAGE_EXPORT_INVOKE_TIMEOUT_MS_BY_CHANNEL});
    const eventSubscriber = createTypedIpcEventSubscriber<IImageExportEventMap>(ipcRenderer);

    return {
        exportPdfToImages: (
            workingPath: TDocumentRef,
            pageNumbers?: number[],
            requestId?: string,
            sourceKind?: 'pdf' | 'djvu',
        ) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportImages, workingPath, pageNumbers, requestId, sourceKind),
        exportPdfToMultiPageTiff: (
            workingPath: TDocumentRef,
            pageNumbers?: number[],
            requestId?: string,
            sourceKind?: 'pdf' | 'djvu',
        ) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff, workingPath, pageNumbers, requestId, sourceKind),
        onProgress: (callback: (progress: IImageExportProgress) => void): (() => void) => {
            const unsubscribe = eventSubscriber.onDecodedPayload(IMAGE_EXPORT_EVENT_CHANNELS.progress, decodeImageExportProgress, callback);
            void invoke(IMAGE_EXPORT_CHANNELS.subscribeProgress);
            return unsubscribe;
        },
    };
}
