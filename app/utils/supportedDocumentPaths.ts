export type TSupportedDocumentKind = 'pdf' | 'djvu' | 'image' | 'document';

export const PDF_INSERT_EXTENSIONS = [
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

export const WORKSPACE_DOCUMENT_EXTENSIONS = [
    '.djvu',
    '.djv',
    ...PDF_INSERT_EXTENSIONS,
] as const;

export const DJVU_DOCUMENT_EXTENSIONS = [
    '.djvu',
    '.djv',
] as const;

export const IMAGE_DOCUMENT_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

export function getDocumentExtension(filePath: string) {
    const normalizedPath = filePath.toLocaleLowerCase();
    const extension = normalizedPath.match(/\.[a-z0-9]+$/u)?.[0] ?? '';
    return extension;
}

function hasSupportedDocumentExtension(
    filePath: string,
    extensions: readonly string[],
) {
    const extension = getDocumentExtension(filePath);
    return extensions.includes(extension);
}

export function isSupportedPdfInsertFilePath(filePath: string) {
    return hasSupportedDocumentExtension(filePath, PDF_INSERT_EXTENSIONS);
}

export function isSupportedWorkspaceDocumentPath(filePath: string) {
    return hasSupportedDocumentExtension(filePath, WORKSPACE_DOCUMENT_EXTENSIONS);
}

export function getDocumentKindFromPath(filePath: string): TSupportedDocumentKind {
    const extension = getDocumentExtension(filePath);
    if (extension === '.pdf') {
        return 'pdf';
    }
    if ((DJVU_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) {
        return 'djvu';
    }
    if ((IMAGE_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) {
        return 'image';
    }
    return 'document';
}
