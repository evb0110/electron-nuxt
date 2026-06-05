import { getDocumentsCapability } from '@app/utils/platformDocuments';

const SUPPORTED_IMAGE_MIME_TYPES = [
    'image/apng',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/webp',
    'image/x-icon',
] as const;
const PREFERRED_CLIPBOARD_IMAGE_TYPES = SUPPORTED_IMAGE_MIME_TYPES.filter(type => type !== 'image/svg+xml');

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

export async function readPageAnnotationImageFileFromClipboard() {
    if (!globalThis.navigator?.clipboard || typeof globalThis.navigator.clipboard.read !== 'function') {
        return null;
    }

    const items = await globalThis.navigator.clipboard.read();
    for (const item of items) {
        const mimeType = PREFERRED_CLIPBOARD_IMAGE_TYPES.find(type => item.types.includes(type));
        if (!mimeType) {
            continue;
        }

        const blob = await item.getType(mimeType);
        return new File([blob], `clipboard-image.${extensionForMimeType(mimeType)}`, {
            type: mimeType,
            lastModified: Date.now(),
        });
    }

    return null;
}
