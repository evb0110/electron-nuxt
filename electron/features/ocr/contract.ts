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
    acknowledgeResultFile: 'ocr:ackResultFile',
    getLanguages: 'ocr:getLanguages',
    validateTools: 'ocr:validateTools',
    preprocessingValidate: 'preprocessing:validate',
    preprocessingPreprocessPage: 'preprocessing:preprocessPage',
} as const;

export const OCR_EVENT_CHANNELS = {
    progress: 'ocr:progress',
    complete: 'ocr:complete',
} as const;

type TOcrCreateSearchablePdfPage = Parameters<IOcrCapability['createSearchablePdf']>[1][number];
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
    [OCR_CHANNELS.acknowledgeResultFile]: {
        args: [requestId: string, pdfPath?: string];
        result: Awaited<ReturnType<IOcrCapability['acknowledgeResultFile']>>;
    };
    [OCR_CHANNELS.getLanguages]: {
        args: [];
        result: Awaited<ReturnType<IOcrCapability['getLanguages']>>;
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
}

export interface IOcrEventMap {
    [OCR_EVENT_CHANNELS.progress]: IOcrProgress;
    [OCR_EVENT_CHANNELS.complete]: IOcrCompleteResult;
}
