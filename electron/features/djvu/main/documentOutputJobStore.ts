import type {
    IDjvuProgress,
    TDocumentOutputJobState,
    TDocumentOutputOperation,
} from '@contracts/electronApiDjvu';
import type { TDocumentOutputJobState as TCommonOutputJobState } from '@contracts/documentOutput';
import { documentOutputService } from '@electron/output/documentOutputService';

function inferOperation(jobId: string): TDocumentOutputOperation {
    return jobId.startsWith('djvu-print-')
        ? 'djvu-print'
        : jobId.startsWith('djvu-open-')
            ? 'djvu-open'
            : 'djvu-convert';
}

function ensureJob(progress: IDjvuProgress) {
    if (!documentOutputService.getState(progress.jobId)) {
        documentOutputService.start({
            jobId: progress.jobId,
            operation: inferOperation(progress.jobId),
            sourceKind: 'djvu',
            initialPhase: progress.phase,
        });
    }
}

function toDjvuState(state: TCommonOutputJobState): TDocumentOutputJobState {
    const progress: IDjvuProgress = {
        jobId: state.jobId,
        phase: state.progress.phase === 'bookmarks'
            || state.progress.phase === 'optimizing'
            || state.progress.phase === 'loading'
            || state.progress.phase === 'printing'
            ? state.progress.phase
            : 'converting',
        percent: state.progress.percent,
        ...(state.progress.current === undefined ? {} : {current: state.progress.current}),
        ...(state.progress.total === undefined ? {} : {total: state.progress.total}),
        ...(state.progress.error === undefined ? {} : {error: state.progress.error}),
    };
    const base = {
        jobId: state.jobId,
        operation: state.operation === 'djvu-print'
            ? 'djvu-print' as const
            : state.operation === 'djvu-open'
                ? 'djvu-open' as const
                : 'djvu-convert' as const,
        progress,
        updatedAtMs: state.updatedAtMs,
    };
    if (state.status === 'handoff') {
        return {
            ...base,
            status: 'handoff',
            artifactPath: state.artifactPath,
        };
    }
    if (state.status === 'completed') {
        return {
            ...base,
            status: 'completed',
            ...('artifactPath' in state && state.artifactPath ? {artifactPath: state.artifactPath} : {}),
        };
    }
    if (state.status === 'failed' || state.status === 'canceled') {
        return {
            ...base,
            status: state.status,
            ...(state.error ? {error: state.error} : {}),
        };
    }
    return {
        ...base,
        status: state.status,
    };
}

export function recordDocumentOutputProgress(progress: IDjvuProgress) {
    ensureJob(progress);
    documentOutputService.update(progress.jobId, {
        phase: progress.phase,
        percent: progress.percent,
        ...(progress.current === undefined ? {} : {current: progress.current}),
        ...(progress.total === undefined ? {} : {total: progress.total}),
        ...(progress.error === undefined ? {} : {error: progress.error}),
    });
    if (progress.status === 'success') documentOutputService.finish(progress.jobId, 'completed');
    if (progress.status === 'failed') documentOutputService.finish(progress.jobId, 'failed', progress.error);
    if (progress.status === 'canceled') documentOutputService.finish(progress.jobId, 'canceled', progress.error);
}

export function recordDocumentOutputHandoff(jobId: string, artifactPath: string, progress: IDjvuProgress) {
    ensureJob(progress);
    documentOutputService.handoff(jobId, artifactPath, {
        phase: progress.phase,
        percent: progress.percent,
        ...(progress.current === undefined ? {} : {current: progress.current}),
        ...(progress.total === undefined ? {} : {total: progress.total}),
    });
}

export function getDocumentOutputJobState(jobId: string) {
    const state = documentOutputService.getState(jobId);
    return state ? toDjvuState(state) : null;
}

export function subscribeDocumentOutputJob(jobId: string, listener: (state: TDocumentOutputJobState) => void) {
    return documentOutputService.subscribe(jobId, state => listener(toDjvuState(state)));
}

export function clearDocumentOutputJobsForTests() {
    documentOutputService.clearForTests();
}
