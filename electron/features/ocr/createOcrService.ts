import {
    handleOcrAcknowledgeResultFileValidated,
    handleOcrCancelValidated,
    handleOcrCreateSearchablePdf,
    handleOcrGetLanguages,
    handleOcrRecognize,
    handleOcrRecognizeBatch,
    handleOcrValidateTools,
    subscribePlainOcrProgress,
} from '@electron/features/ocr/main/ocrOperations';
import {
    handlePreprocessingValidate,
    handlePreprocessPage,
} from '@electron/ocr/preprocessingHandlers';
import type {
    IOcrOperationContext,
    IOcrService,
} from '@electron/features/ocr/ports';
import { subscribeManagedOcrProgress } from '@electron/ocr/jobManager';
import { OCR_EVENT_CHANNELS } from '@electron/features/ocr/contract';

type TPreprocessPageContext = Parameters<typeof handlePreprocessPage>[0];

function createPreprocessPageContext(context: IOcrOperationContext): TPreprocessPageContext {
    const {sender} = context;
    const preprocessSender: TPreprocessPageContext['sender'] = {
        isDestroyed: () => sender.isDestroyed(),
        once: (event, listener) => {
            if (event === 'destroyed') {
                return sender.once('destroyed', listener);
            }
            return sender.once('render-process-gone', listener);
        },
        on: (event, listener) => sender.on(event, listener),
        removeListener: (event, listener) => {
            if (event === 'destroyed') {
                return sender.removeListener('destroyed', listener as () => void);
            }
            if (event === 'render-process-gone') {
                return sender.removeListener('render-process-gone', listener as () => void);
            }
            return sender.removeListener('did-start-navigation', listener);
        },
    };
    return {sender: preprocessSender};
}

export function createOcrService(): IOcrService {
    return {
        recognize: (context, request) =>
            handleOcrRecognize(context, request),
        recognizeBatch: (context, pages, requestId) =>
            handleOcrRecognizeBatch(context, pages, requestId),
        createSearchablePdf: (context, sourcePdfPath, pages, requestId, renderDpiOrOptions) =>
            handleOcrCreateSearchablePdf(context, sourcePdfPath, pages, requestId, renderDpiOrOptions),
        cancel: (context, requestId) =>
            handleOcrCancelValidated(context, requestId),
        acknowledgeResultFile: (context, requestId, pdfPath) =>
            handleOcrAcknowledgeResultFileValidated(context, requestId, pdfPath),
        getLanguages: () =>
            handleOcrGetLanguages(),
        validateTools: () =>
            handleOcrValidateTools(),
        preprocessingValidate: () =>
            handlePreprocessingValidate(),
        preprocessPage: (context, imageData, usePreprocessing) =>
            handlePreprocessPage(createPreprocessPageContext(context), imageData, usePreprocessing),
        subscribeProgress: (context) => {
            subscribePlainOcrProgress(context);
            subscribeManagedOcrProgress(context.senderId, {
                key: `web-contents:${context.senderId}`,
                isDestroyed: () => context.sender.isDestroyed(),
                send: (_channel, payload) => context.sender.send(OCR_EVENT_CHANNELS.progress, payload),
            });
        },
    };
}
