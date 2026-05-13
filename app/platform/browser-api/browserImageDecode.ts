export type TDecodedBrowserImage = ImageBitmap | HTMLImageElement;

interface IDecodeBrowserImageBlobOptions { fallbackErrorMessage: string }

export async function decodeBrowserImageBlob(
    blob: Blob,
    options: IDecodeBrowserImageBlobOptions,
): Promise<TDecodedBrowserImage> {
    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(blob);
    }

    if (
        typeof document === 'undefined'
        || typeof URL === 'undefined'
        || typeof Image === 'undefined'
    ) {
        throw new Error('Image decoding is unavailable in the current runtime');
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error(options.fallbackErrorMessage));
            image.src = objectUrl;
        });
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}
