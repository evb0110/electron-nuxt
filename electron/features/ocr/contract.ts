import type {
    IOcrCapability,
    IOcrCompleteResult,
    IOcrProgress,
    IOcrRecognizeRequest,
    IOcrSearchablePdfOptions,
    IOcrToolValidationResult,
} from '@contracts/electronApiOcr';

export const OCR_CHANNELS = {
    recognize: 'ocr:recognize',
    recognizeBatch: 'ocr:recognizeBatch',
    createSearchablePdf: 'ocr:createSearchablePdf',
    cancel: 'ocr:cancel',
    getJobState: 'ocr:job:get-state',
    subscribeJob: 'ocr:job:subscribe',
    reconnectJob: 'ocr:job:reconnect',
    acknowledgeResultFile: 'ocr:ackResultFile',
    getLanguages: 'ocr:getLanguages',
    resolveDocumentTextCatalog: 'ocr:resolveDocumentTextCatalog',
    resolveDocumentOcrAvailability: 'ocr:resolveDocumentOcrAvailability',
    resolveDocumentOcrPage: 'ocr:resolveDocumentOcrPage',
    validateTools: 'ocr:validateTools',
    preprocessingValidate: 'preprocessing:validate',
    preprocessingPreprocessPage: 'preprocessing:preprocessPage',
    subscribeProgress: 'ocr:progress:subscribe',
} as const;

export const OCR_EVENT_CHANNELS = {
    progress: 'ocr:progress',
    complete: 'ocr:complete',
} as const;

type TOcrCreateSearchablePdfPage = Parameters<IOcrCapability['createSearchablePdf']>[1][number];
type TOcrAcknowledgeResultFileArgs = Parameters<IOcrCapability['acknowledgeResultFile']>;
type TOcrPreprocessing = IOcrCapability['preprocessing'];

export interface IOcrInvokeMap {
    [OCR_CHANNELS.recognize]: {
        args: [request: IOcrRecognizeRequest];
        result: Awaited<ReturnType<IOcrCapability['recognize']>>;
    };
    [OCR_CHANNELS.recognizeBatch]: {
        args: [pages: IOcrRecognizeRequest[], requestId: string];
        result: Awaited<ReturnType<IOcrCapability['recognizeBatch']>>;
    };
    [OCR_CHANNELS.createSearchablePdf]: {
        args: [sourcePdfPath: string, pages: TOcrCreateSearchablePdfPage[], requestId: string, renderDpiOrOptions?: number | IOcrSearchablePdfOptions];
        result: Awaited<ReturnType<IOcrCapability['createSearchablePdf']>>;
    };
    [OCR_CHANNELS.cancel]: {
        args: [requestId: string];
        result: Awaited<ReturnType<IOcrCapability['cancel']>>;
    };
    [OCR_CHANNELS.getJobState]: {
        args: [requestId: string];
        result: Awaited<ReturnType<IOcrCapability['getJobState']>>;
    };
    [OCR_CHANNELS.subscribeJob]: {
        args: [requestId: string];
        result: Awaited<ReturnType<IOcrCapability['subscribeJob']>>;
    };
    [OCR_CHANNELS.reconnectJob]: {
        args: [requestId: string];
        result: Awaited<ReturnType<IOcrCapability['reconnectJob']>>;
    };
    [OCR_CHANNELS.acknowledgeResultFile]: {
        args: TOcrAcknowledgeResultFileArgs;
        result: Awaited<ReturnType<IOcrCapability['acknowledgeResultFile']>>;
    };
    [OCR_CHANNELS.getLanguages]: {
        args: [];
        result: Awaited<ReturnType<IOcrCapability['getLanguages']>>;
    };
    [OCR_CHANNELS.resolveDocumentTextCatalog]: {
        args: Parameters<IOcrCapability['resolveDocumentTextCatalog']>;
        result: Awaited<ReturnType<IOcrCapability['resolveDocumentTextCatalog']>>;
    };
    [OCR_CHANNELS.resolveDocumentOcrAvailability]: {
        args: Parameters<NonNullable<IOcrCapability['resolveDocumentOcrAvailability']>>;
        result: Awaited<ReturnType<NonNullable<IOcrCapability['resolveDocumentOcrAvailability']>>>;
    };
    [OCR_CHANNELS.resolveDocumentOcrPage]: {
        args: Parameters<NonNullable<IOcrCapability['resolveDocumentOcrPage']>>;
        result: Awaited<ReturnType<NonNullable<IOcrCapability['resolveDocumentOcrPage']>>>;
    };
    [OCR_CHANNELS.validateTools]: {
        args: [];
        result: IOcrToolValidationResult;
    };
    [OCR_CHANNELS.preprocessingValidate]: {
        args: [];
        result: Awaited<ReturnType<TOcrPreprocessing['validate']>>;
    };
    [OCR_CHANNELS.preprocessingPreprocessPage]: {
        args: [imageData: Uint8Array, usePreprocessing: boolean];
        result: Awaited<ReturnType<TOcrPreprocessing['preprocessPage']>>;
    };
    [OCR_CHANNELS.subscribeProgress]: {
        args: [];
        result: undefined;
    };
}

export interface IOcrEventMap {
    [OCR_EVENT_CHANNELS.progress]: IOcrProgress;
    [OCR_EVENT_CHANNELS.complete]: IOcrCompleteResult;
}
