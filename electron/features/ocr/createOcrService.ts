import {
    handleOcrAcknowledgeResultFileValidated,
    handleOcrCancelValidated,
    handleOcrCreateSearchablePdf,
    handleOcrGetLanguages,
    handleGetOcrJobState,
    handleSubscribeOcrJob,
    handleOcrRecognize,
    handleOcrRecognizeBatch,
    handleResolveDocumentOcrAvailability,
    handleResolveDocumentOcrPage,
    handleResolveDocumentTextCatalog,
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
        recognize: handleOcrRecognize,
        recognizeBatch: handleOcrRecognizeBatch,
        createSearchablePdf: handleOcrCreateSearchablePdf,
        cancel: handleOcrCancelValidated,
        getJobState: handleGetOcrJobState,
        subscribeJob: handleSubscribeOcrJob,
        reconnectJob: handleSubscribeOcrJob,
        acknowledgeResultFile: handleOcrAcknowledgeResultFileValidated,
        getLanguages: handleOcrGetLanguages,
        resolveDocumentTextCatalog: handleResolveDocumentTextCatalog,
        resolveDocumentOcrAvailability: handleResolveDocumentOcrAvailability,
        resolveDocumentOcrPage: handleResolveDocumentOcrPage,
        validateTools: handleOcrValidateTools,
        preprocessingValidate: handlePreprocessingValidate,
        preprocessPage: (context, imageData, usePreprocessing) =>
            handlePreprocessPage(createPreprocessPageContext(context), imageData, usePreprocessing),
        subscribeProgress: (context) => {
            subscribePlainOcrProgress(context);
            subscribeManagedOcrProgress(context);
        },
    };
}
