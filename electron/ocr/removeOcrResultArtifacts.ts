import * as fsPromises from 'node:fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { ILogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

export async function removeOcrResultArtifacts(path: string, logger: ILogger) {
    await fsPromises.rm(`${path}.ocr`, {
        recursive: true,
        force: true,
    }).catch(error => logger.warn(
        `Failed to cleanup staged OCR catalog "${path}.ocr": ${getErrorMessage(error)}`,
    ));
    try {
        await fsPromises.unlink(path);
        return true;
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return true;
        }
        logger.warn(`Failed to cleanup OCR temp result file "${path}": ${getErrorMessage(error)}`);
        return false;
    }
}
