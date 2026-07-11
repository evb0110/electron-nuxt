import { sumBy } from 'es-toolkit/math';
import {
    OCR_QUEUE_MAX_BUFFERED_BYTES,
    OCR_QUEUE_MAX_DOCUMENT_PAGE_WORK,
    OCR_QUEUE_MAX_GLOBAL_PAGE_WORK,
    OCR_QUEUE_MAX_SIZE,
} from '@electron/ocr/jobManager.config';
import type {
    IOcrActiveJob,
    IOcrPreparingJob,
} from '@electron/ocr/jobManager.types';

interface IOcrQueueState {
    activeJobs: Iterable<IOcrActiveJob>;
    preparingJobs: ReadonlyMap<string, IOcrPreparingJob>;
}

interface IOcrQueueCapacityOptions {excludePreparingJobId?: string;}

export type TOcrQueueCapacityResult = {ok: true} | {
    ok: false;
    error: string
};

function getBufferedWork(
    state: IOcrQueueState,
    field: 'requestedBytes' | 'pageWork',
    options: IOcrQueueCapacityOptions = {},
) {
    const preparing = sumBy([...state.preparingJobs.values()], job =>
        job.scopedJobId === options.excludePreparingJobId ? 0 : job[field]);
    return preparing
        + sumBy([...state.activeJobs], job => job[field]);
}

export function getBufferedOcrBytes(state: IOcrQueueState, options: IOcrQueueCapacityOptions = {}) {
    return getBufferedWork(state, 'requestedBytes', options);
}

export function ensureOcrQueueCapacity(
    state: IOcrQueueState,
    additionalWork: {
        bytes: number;
        pageWork: number;
        documentJobKey: string
    },
    options: IOcrQueueCapacityOptions = {},
): TOcrQueueCapacityResult {
    const preparingCount = options.excludePreparingJobId === undefined
        ? state.preparingJobs.size
        : state.preparingJobs.size - (state.preparingJobs.has(options.excludePreparingJobId) ? 1 : 0);
    if (preparingCount >= OCR_QUEUE_MAX_SIZE) {
        return {
            ok: false,
            error: `OCR queue is full (${OCR_QUEUE_MAX_SIZE} jobs)`,
        };
    }
    if (getBufferedOcrBytes(state, options) + additionalWork.bytes > OCR_QUEUE_MAX_BUFFERED_BYTES) {
        return {
            ok: false,
            error: `OCR queue is full (buffer cap ${Math.floor(OCR_QUEUE_MAX_BUFFERED_BYTES / (1024 * 1024))}MB reached)`,
        };
    }
    const documentPageWork = [
        ...state.preparingJobs.values(),
        ...state.activeJobs,
    ].reduce((total, job) => total + (
        job.documentJobKey === additionalWork.documentJobKey
        && job.scopedJobId !== options.excludePreparingJobId ? job.pageWork : 0
    ), 0);
    if (documentPageWork + additionalWork.pageWork > OCR_QUEUE_MAX_DOCUMENT_PAGE_WORK) {
        return {
            ok: false,
            error: `OCR queue is full (document page-work cap ${OCR_QUEUE_MAX_DOCUMENT_PAGE_WORK} reached)`,
        };
    }
    if (getBufferedWork(state, 'pageWork', options) + additionalWork.pageWork > OCR_QUEUE_MAX_GLOBAL_PAGE_WORK) {
        return {
            ok: false,
            error: `OCR queue is full (global page-work cap ${OCR_QUEUE_MAX_GLOBAL_PAGE_WORK} reached)`,
        };
    }
    return {ok: true};
}
