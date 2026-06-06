import { getDocumentsCapability } from '@app/utils/platformDocuments';

function mimeTypeFromPath(path: string) {
    const normalized = path.toLowerCase();
    if (normalized.endsWith('.apng')) {
        return 'image/apng';
    }
    if (normalized.endsWith('.avif')) {
        return 'image/avif';
    }
    if (normalized.endsWith('.bmp')) {
        return 'image/bmp';
    }
    if (normalized.endsWith('.gif')) {
        return 'image/gif';
    }
    if (normalized.endsWith('.jpeg') || normalized.endsWith('.jpg')) {
        return 'image/jpeg';
    }
    if (normalized.endsWith('.png')) {
        return 'image/png';
    }
    if (normalized.endsWith('.svg') || normalized.endsWith('.svgz')) {
        return 'image/svg+xml';
    }
    if (normalized.endsWith('.webp')) {
        return 'image/webp';
    }
    if (normalized.endsWith('.ico')) {
        return 'image/x-icon';
    }
    return 'image/png';
}

function extensionForMimeType(mimeType: string) {
    switch (mimeType) {
        case 'image/apng':
            return 'apng';
        case 'image/avif':
            return 'avif';
        case 'image/bmp':
            return 'bmp';
        case 'image/gif':
            return 'gif';
        case 'image/jpeg':
            return 'jpg';
        case 'image/png':
            return 'png';
        case 'image/webp':
            return 'webp';
        case 'image/x-icon':
            return 'ico';
        default:
            return 'img';
    }
}

export async function pickPageAnnotationImageFile() {
    const documents = getDocumentsCapability();
    const imagePath = await documents.openImageDialog();
    if (!imagePath) {
        return null;
    }

    try {
        const bytes = await documents.readFile(imagePath);
        const fileBytes = Uint8Array.from(bytes);
        const mimeType = mimeTypeFromPath(imagePath);
        const fileName = imagePath.split(/[\\/]/).pop() ?? `image.${extensionForMimeType(mimeType)}`;
        return new File([fileBytes], fileName, {
            type: mimeType,
            lastModified: Date.now(),
        });
    } finally {
        if (typeof documents.cleanupFile === 'function') {
            await documents.cleanupFile(imagePath).catch(() => {});
        }
    }
}
