import { statSync } from 'fs';
import {
    open,
    rename,
    unlink,
} from 'fs/promises';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getNativeToolPaths } from '@electron/native-tools/getNativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('pdfDecrypt');
const DECRYPT_TIMEOUT_MS = 30_000;
const SCAN_CHUNK_SIZE = 8192;

async function hasEncryptMarker(filePath: string) {
    const stats = statSync(filePath);
    const handle = await open(filePath, 'r');
    try {
        const headSize = Math.min(SCAN_CHUNK_SIZE, stats.size);

        const headBuf = Buffer.alloc(headSize);
        await handle.read(headBuf, 0, headSize, 0);
        if (headBuf.toString('latin1').includes('/Encrypt')) {
            return true;
        }

        if (stats.size > SCAN_CHUNK_SIZE) {
            const tailSize = Math.min(SCAN_CHUNK_SIZE, stats.size - headSize);
            const tailBuf = Buffer.alloc(tailSize);
            await handle.read(tailBuf, 0, tailSize, stats.size - tailSize);
            if (tailBuf.toString('latin1').includes('/Encrypt')) {
                return true;
            }
        }

        return false;
    } finally {
        await handle.close();
    }
}

export async function decryptPdfFileIfNeeded(filePath: string) {
    try {
        if (!await hasEncryptMarker(filePath)) {
            return false;
        }

        const qpdf = getNativeToolPaths().qpdf;
        const tempPath = `${filePath}.decrypted`;

        try {
            await runNativeToolCommand(qpdf, [
                '--decrypt',
                filePath,
                tempPath,
            ], {
                timeoutMs: DECRYPT_TIMEOUT_MS,
                commandLabel: 'qpdf(decrypt)',
            });
            await rename(tempPath, filePath);
            logger.info('Stripped PDF encryption from working copy');
            return true;
        } catch {
            await unlink(tempPath).catch(() => undefined);
            return false;
        }
    } catch (error) {
        logger.debug(`PDF encrypt check skipped: ${getErrorMessage(error)}`);
        return false;
    }
}
