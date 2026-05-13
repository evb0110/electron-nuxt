const SUPPORTED_IMAGE_EXTENSIONS = [
    '.apng',
    '.avif',
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.tif',
    '.tiff',
    '.webp',
    '.ico',
] as const;

const OPEN_IMAGE_ACCEPT = 'image/*';
const OPEN_PDF_ACCEPT = '.pdf,application/pdf';
const OPEN_DJVU_ACCEPT = '.djvu,.djv';
const OPEN_PDF_IMAGE_ACCEPT = [
    OPEN_PDF_ACCEPT,
    ...SUPPORTED_IMAGE_EXTENSIONS,
].join(',');
const OPEN_INPUT_ACCEPT = [
    OPEN_PDF_IMAGE_ACCEPT,
    OPEN_DJVU_ACCEPT,
].join(',');

interface IFilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
}

function buildOpenPdfPickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Documents',
        accept: {
            'application/pdf': ['.pdf'],
            'application/octet-stream': [
                '.djvu',
                '.djv',
            ],
            'image/*': [...SUPPORTED_IMAGE_EXTENSIONS],
        },
    }];
}

function buildOpenPdfImagePickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Documents',
        accept: {
            'application/pdf': ['.pdf'],
            'image/*': [...SUPPORTED_IMAGE_EXTENSIONS],
        },
    }];
}

function buildImagePickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Images',
        accept: { 'image/*': [...SUPPORTED_IMAGE_EXTENSIONS] },
    }];
}

function buildPdfSaveTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'PDF Documents',
        accept: { 'application/pdf': ['.pdf'] },
    }];
}

function buildDocxSaveTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Word Documents',
        accept: {'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']},
    }];
}

export {
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    OPEN_PDF_IMAGE_ACCEPT,
    buildDocxSaveTypes,
    buildImagePickerTypes,
    buildOpenPdfImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildPdfSaveTypes,
};
export type { IFilePickerAcceptType };
