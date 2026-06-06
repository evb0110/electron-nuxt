import { existsSync } from 'fs';
import { join } from 'path';
import { uniq } from 'es-toolkit/array';
import type { IOcrPreparingJob } from '@electron/ocr/jobManager.types';
import { ensureTessdataLanguages } from '@electron/ocr/languageModels';
import { getOcrToolPaths } from '@electron/ocr/paths';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';
import { createTimeoutError } from '@electron/ocr/jobManagerProtocol';
import { createLogger } from '@electron/utils/createLogger';

const log = createLogger('ocr-ipc');

function getOcrJobLanguages(pages: IOcrPdfPageRequest[]) {
    return uniq(pages.flatMap(page => page.languages));
}

function logMissingLanguageModels(languages: string[]) {
    const tessdataDir = getOcrToolPaths().tessdata;
    const missingLanguages = languages.filter(languageCode =>
        !existsSync(join(tessdataDir, `${languageCode}.traineddata`)),
    );
    if (missingLanguages.length > 0) {
        log.warn(`Missing OCR language models in ${tessdataDir}; downloading: ${missingLanguages.join(', ')}`);
    }
}

function startModelPrepTimeout(
    preparingJob: IOcrPreparingJob,
    timeoutMs: number,
) {
    const modelPrepTimeout = setTimeout(() => {
        if (!preparingJob.abortController.signal.aborted) {
            preparingJob.abortController.abort(
                createTimeoutError(`OCR model preparation timed out after ${timeoutMs}ms`),
            );
        }
    }, timeoutMs);
    modelPrepTimeout.unref?.();
    return modelPrepTimeout;
}

export async function prepareLanguageModelsForJob(
    preparingJob: IOcrPreparingJob,
    pages: IOcrPdfPageRequest[],
    timeoutMs: number,
) {
    const languages = getOcrJobLanguages(pages);
    logMissingLanguageModels(languages);

    const modelPrepTimeout = startModelPrepTimeout(preparingJob, timeoutMs);
    try {
        await ensureTessdataLanguages(languages, { signal: preparingJob.abortController.signal });
    } finally {
        clearTimeout(modelPrepTimeout);
    }
}
