const PDF_INSERT_EXTENSIONS = [
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

const WORKSPACE_DOCUMENT_EXTENSIONS = [
    '.djvu',
    '.djv',
    ...PDF_INSERT_EXTENSIONS,
] as const;

function hasSupportedDocumentExtension(
    filePath: string,
    extensions: readonly string[],
) {
    const lowerPath = filePath.toLowerCase();
    return extensions.some(extension => lowerPath.endsWith(extension));
}

export function isSupportedPdfInsertFilePath(filePath: string) {
    return hasSupportedDocumentExtension(filePath, PDF_INSERT_EXTENSIONS);
}

export function isSupportedWorkspaceDocumentPath(filePath: string) {
    return hasSupportedDocumentExtension(filePath, WORKSPACE_DOCUMENT_EXTENSIONS);
}
