import { randomUUID } from 'crypto';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import {
    preprocessPageForOcr,
    validatePreprocessingSetup,
} from '@electron/ocr/preprocessing';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getAppTempDir } from '@electron/utils/appTempDir';

const log = createLogger('ocr-ipc');
const PREPROCESS_MAX_IMAGE_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_PREPROCESS_MAX_IMAGE_MB ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 64 * 1024 * 1024;
    }
    return Math.min(parsed, 512) * 1024 * 1024;
})();
const PREPROCESS_MAX_DECODED_PIXELS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_PREPROCESS_MAX_DECODED_PIXELS ?? '45000000', 10);
    if (!Number.isFinite(parsed) || parsed < 1_000_000) {
        return 45_000_000;
    }
    return Math.min(parsed, 250_000_000);
})();
const PREPROCESS_MAX_IMAGE_DIMENSION = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_PREPROCESS_MAX_IMAGE_DIMENSION ?? '32767', 10);
    if (!Number.isFinite(parsed) || parsed < 1024) {
        return 32767;
    }
    return Math.min(parsed, 100_000);
})();

interface IImageDimensions {
    width: number;
    height: number;
}

type TPreprocessSenderNavigationListener = (
    event: Electron.Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
) => void;
type TPreprocessSenderLifecycleListener = () => void;

interface IPreprocessPageSender {
    isDestroyed: () => boolean;
    once: (event: 'destroyed' | 'render-process-gone', listener: TPreprocessSenderLifecycleListener) => unknown;
    on: (
        event: 'did-start-navigation',
        listener: TPreprocessSenderNavigationListener,
    ) => unknown;
    removeListener: (
        event: 'destroyed' | 'render-process-gone' | 'did-start-navigation',
        listener: TPreprocessSenderLifecycleListener | TPreprocessSenderNavigationListener,
    ) => unknown;
}

interface IPreprocessPageContext {sender: IPreprocessPageSender;}

function readPngDimensions(bytes: Uint8Array): IImageDimensions | null {
    const pngSignature = [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ];
    if (bytes.byteLength < 24 || !pngSignature.every((value, index) => bytes[index] === value)) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        width: view.getUint32(16),
        height: view.getUint32(20),
    };
}

function readJpegDimensions(bytes: Uint8Array): IImageDimensions | null {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
            offset++;
            continue;
        }
        const marker = bytes[offset + 1] ?? 0;
        offset += 2;
        if (marker === 0xd8 || marker === 0xd9) {
            continue;
        }
        if (offset + 2 > bytes.byteLength) {
            return null;
        }
        const segmentLength = view.getUint16(offset);
        if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
            return null;
        }
        const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf);
        if (isStartOfFrame && segmentLength >= 7) {
            return {
                height: view.getUint16(offset + 3),
                width: view.getUint16(offset + 5),
            };
        }
        offset += segmentLength;
    }
    return null;
}

function readImageDimensions(bytes: Uint8Array): IImageDimensions {
    const dimensions = readPngDimensions(bytes) ?? readJpegDimensions(bytes);
    if (!dimensions) {
        throw new Error('Invalid preprocessing payload: imageData must be a PNG or JPEG image with readable dimensions');
    }
    return dimensions;
}

function validateDecodedDimensions(bytes: Uint8Array, label = 'imageData') {
    const dimensions = readImageDimensions(bytes);
    if (
        dimensions.width <= 0
        || dimensions.height <= 0
        || dimensions.width > PREPROCESS_MAX_IMAGE_DIMENSION
        || dimensions.height > PREPROCESS_MAX_IMAGE_DIMENSION
        || dimensions.width * dimensions.height > PREPROCESS_MAX_DECODED_PIXELS
    ) {
        throw new Error(
            `Invalid preprocessing payload: ${label} decoded dimensions ${dimensions.width}x${dimensions.height} exceed preprocessing limits`,
        );
    }
}

function normalizePreprocessImageData(imageData: unknown): Uint8Array {
    let bytes: Uint8Array;
    if (imageData instanceof Uint8Array) {
        bytes = imageData;
    } else if (imageData instanceof ArrayBuffer) {
        bytes = new Uint8Array(imageData);
    } else if (ArrayBuffer.isView(imageData)) {
        bytes = new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength);
    } else {
        throw new Error('Invalid preprocessing payload: imageData must be a Uint8Array');
    }
    if (bytes.byteLength === 0) {
        throw new Error('Invalid preprocessing payload: imageData must not be empty');
    }
    if (bytes.byteLength > PREPROCESS_MAX_IMAGE_BYTES) {
        throw new Error(`Invalid preprocessing payload: imageData exceeds ${PREPROCESS_MAX_IMAGE_BYTES} bytes`);
    }
    validateDecodedDimensions(bytes);
    return bytes;
}

function createPreprocessingAbortResult(imageData: Uint8Array, error: string) {
    return {
        success: false,
        imageData,
        error,
    };
}

export async function handlePreprocessingValidate() {
    const validation = await validatePreprocessingSetup();
    return {
        valid: validation.valid,
        available: validation.available,
        missing: validation.missing,
    };
}

export async function handlePreprocessPage(
    context: IPreprocessPageContext,
    imageData: unknown,
    usePreprocessing: unknown,
) {
    const abortController = new AbortController();
    const handleSenderGone = () => {
        abortController.abort();
    };
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            handleSenderGone();
        }
    };
    let normalizedImageData: Uint8Array = new Uint8Array();

    try {
        normalizedImageData = normalizePreprocessImageData(imageData);
        if (typeof usePreprocessing !== 'boolean') {
            throw new Error('Invalid preprocessing payload: usePreprocessing must be a boolean');
        }

        context.sender.once('destroyed', handleSenderGone);
        context.sender.once('render-process-gone', handleSenderGone);
        context.sender.on('did-start-navigation', handleNavigation);

        if (context.sender.isDestroyed()) {
            return createPreprocessingAbortResult(normalizedImageData, 'Renderer disconnected before preprocessing started');
        }

        if (!usePreprocessing) {
            return {
                success: true,
                imageData: normalizedImageData,
                message: 'Preprocessing disabled',
            };
        }

        const validation = await validatePreprocessingSetup();
        if (abortController.signal.aborted) {
            return createPreprocessingAbortResult(normalizedImageData, 'Renderer disconnected during preprocessing');
        }
        if (!validation.valid) {
            return {
                success: true,
                imageData: normalizedImageData,
                message: 'Preprocessing unavailable on this platform/architecture; using original image.',
            };
        }

        const tempDir = getAppTempDir();
        const uuid = randomUUID();
        const inputPath = join(tempDir, `preprocess-input-${uuid}.png`);
        const outputPath = join(tempDir, `preprocess-output-${uuid}.png`);

        try {
            const imageBuffer = Buffer.from(normalizedImageData);
            await writeFile(inputPath, imageBuffer);

            log.debug(`Preprocessing image: ${inputPath}`);
            const result = await preprocessPageForOcr(inputPath, outputPath, abortController.signal);

            if (!result.success) {
                log.debug(`Preprocessing failed: ${result.error}`);
                if (abortController.signal.aborted) {
                    return createPreprocessingAbortResult(normalizedImageData, 'Renderer disconnected during preprocessing');
                }
                return {
                    success: true,
                    imageData: normalizedImageData,
                    message: 'Preprocessing failed; using original image.',
                };
            }

            const preprocessedBuffer = await readFile(outputPath);
            const preprocessedData = new Uint8Array(preprocessedBuffer);
            validateDecodedDimensions(preprocessedData, 'preprocessed imageData');

            log.debug(`Preprocessing successful: ${inputPath} -> ${outputPath}`);

            return {
                success: true,
                imageData: preprocessedData,
                message: 'Preprocessing complete',
            };
        } finally {
            try {
                await unlink(inputPath);
            } catch (cleanupErr) {
                log.warn(`Cleanup warning (inputPath): ${getErrorMessage(cleanupErr)}`);
            }
            try {
                await unlink(outputPath);
            } catch (cleanupErr) {
                log.warn(`Cleanup warning (outputPath): ${getErrorMessage(cleanupErr)}`);
            }
        }
    } catch (err) {
        if (abortController.signal.aborted) {
            return createPreprocessingAbortResult(normalizedImageData, 'Renderer disconnected during preprocessing');
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Preprocessing error: ${errMsg}`);
        return {
            success: false,
            imageData: normalizedImageData,
            error: errMsg,
        };
    } finally {
        context.sender.removeListener('destroyed', handleSenderGone);
        context.sender.removeListener('render-process-gone', handleSenderGone);
        context.sender.removeListener('did-start-navigation', handleNavigation);
    }
}
