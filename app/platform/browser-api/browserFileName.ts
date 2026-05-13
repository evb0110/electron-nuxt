function getExtension(fileName: string) {
    const lowerName = fileName.toLowerCase();
    const lastDot = lowerName.lastIndexOf('.');
    return lastDot >= 0 ? lowerName.slice(lastDot) : '';
}

function isPdfFileName(fileName: string) {
    return getExtension(fileName) === '.pdf';
}

function isDjvuFileName(fileName: string) {
    const extension = getExtension(fileName);
    return extension === '.djvu' || extension === '.djv';
}

function ensurePdfExtension(fileName: string) {
    return fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
}

function ensureDocxExtension(fileName: string) {
    return fileName.toLowerCase().endsWith('.docx')
        ? fileName
        : `${fileName}.docx`;
}

export {
    ensureDocxExtension,
    ensurePdfExtension,
    getExtension,
    isDjvuFileName,
    isPdfFileName,
};
