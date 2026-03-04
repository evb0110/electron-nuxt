import type { IpcMainInvokeEvent } from 'electron';
import { app } from 'electron';
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
import { createLogger } from '@electron/utils/logger';

const log = createLogger('ocr-ipc');
const PREPROCESS_MAX_IMAGE_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_PREPROCESS_MAX_IMAGE_MB ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 64 * 1024 * 1024;
    }
    return Math.min(parsed, 512) * 1024 * 1024;
})();

function normalizePreprocessImageData(imageData: unknown): Uint8Array<ArrayBufferLike> {
    let bytes: Uint8Array<ArrayBufferLike>;
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
    return bytes;
}

export function handlePreprocessingValidate() {
    const validation = validatePreprocessingSetup();
    return {
        valid: validation.valid,
        available: validation.available,
        missing: validation.missing,
    };
}

export async function handlePreprocessPage(
    event: IpcMainInvokeEvent,
    imageData: unknown,
    usePreprocessing: unknown,
) {
    const abortController = new AbortController();
    const handleSenderGone = () => {
        abortController.abort();
    };
    let normalizedImageData: Uint8Array<ArrayBufferLike> = new Uint8Array();

    try {
        normalizedImageData = normalizePreprocessImageData(imageData);
        if (typeof usePreprocessing !== 'boolean') {
            throw new Error('Invalid preprocessing payload: usePreprocessing must be a boolean');
        }

        event.sender.once('destroyed', handleSenderGone);
        event.sender.once('render-process-gone', handleSenderGone);

        if (event.sender.isDestroyed()) {
            return {
                success: false,
                imageData: normalizedImageData,
                error: 'Renderer disconnected before preprocessing started',
            };
        }

        if (!usePreprocessing) {
            return {
                success: true,
                imageData: normalizedImageData,
                message: 'Preprocessing disabled',
            };
        }

        const validation = validatePreprocessingSetup();
        if (!validation.valid) {
            return {
                success: true,
                imageData: normalizedImageData,
                message: 'Preprocessing unavailable on this platform/architecture; using original image.',
            };
        }

        const tempDir = app.getPath('temp');
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
                return {
                    success: true,
                    imageData: normalizedImageData,
                    message: 'Preprocessing failed; using original image.',
                };
            }

            const preprocessedBuffer = await readFile(outputPath);
            const preprocessedData = new Uint8Array(preprocessedBuffer);

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
                log.warn(`Cleanup warning (inputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
            }
            try {
                await unlink(outputPath);
            } catch (cleanupErr) {
                log.warn(`Cleanup warning (outputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
            }
        }
    } catch (err) {
        if (abortController.signal.aborted) {
            return {
                success: false,
                imageData: normalizedImageData,
                error: 'Renderer disconnected during preprocessing',
            };
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Preprocessing error: ${errMsg}`);
        return {
            success: false,
            imageData: normalizedImageData,
            error: errMsg,
        };
    } finally {
        event.sender.removeListener('destroyed', handleSenderGone);
        event.sender.removeListener('render-process-gone', handleSenderGone);
    }
}
