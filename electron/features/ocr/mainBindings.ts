import type { IpcMainInvokeEvent } from 'electron';
import type {
    OCR_PLATFORM_FEATURE,
    OCR_PREPROCESSING_PLATFORM_FEATURE,
} from '@contracts/ocrPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import {
    handleOcrAcknowledgeResultFileValidated,
    handleOcrCancelValidated,
    handleOcrCreateSearchablePdf,
    handleOcrGetLanguages,
    handleOcrRecognize,
    handleOcrRecognizeBatch,
    handleOcrValidateTools,
    handleResolveDocumentOcrAvailability,
    handleResolveDocumentOcrPage,
    handleResolveDocumentTextCatalog,
    subscribePlainOcrProgress,
} from '@electron/features/ocr/main/ocrOperations';
import {
    getOcrJobState,
    subscribeManagedOcrProgress,
    subscribeOcrJob,
} from '@electron/ocr/jobManager';
import {
    handlePreprocessingValidate,
    handlePreprocessPage,
} from '@electron/ocr/preprocessingHandlers';

export const ocrMainBindings = {
    recognize: handleOcrRecognize,
    recognizeBatch: handleOcrRecognizeBatch,
    cancel: handleOcrCancelValidated,
    getJobState: getOcrJobState,
    subscribeJob: subscribeOcrJob,
    reconnectJob: subscribeOcrJob,
    getLanguages: handleOcrGetLanguages,
    resolveDocumentTextCatalog: handleResolveDocumentTextCatalog,
    resolveDocumentOcrAvailability: handleResolveDocumentOcrAvailability,
    resolveDocumentOcrPage: handleResolveDocumentOcrPage,
    validateTools: handleOcrValidateTools,
    acknowledgeResultFile: handleOcrAcknowledgeResultFileValidated,
    createSearchablePdf: handleOcrCreateSearchablePdf,
    subscribeProgress: (context: Parameters<typeof subscribePlainOcrProgress>[0]) => {
        subscribePlainOcrProgress(context);
        subscribeManagedOcrProgress(context);
    },
} satisfies TFeatureMainBindings<typeof OCR_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export const ocrPreprocessingMainBindings = {
    validate: handlePreprocessingValidate,
    preprocessPage: handlePreprocessPage,
} satisfies TFeatureMainBindings<typeof OCR_PREPROCESSING_PLATFORM_FEATURE, IpcMainInvokeEvent>;
