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
