import type {
    IOcrJobProjectionState,
    TOcrJobProjectionPhase,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import { documentOutputService } from '@electron/output/documentOutputService';
import { toScopedOcrJobId } from '@electron/ocr/jobManagerProtocol';

const ocrProjectionPolicies = new Map<string, {
    supersessionPolicy: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged: boolean;
}>();

export function registerOcrJobProjectionPolicy(
    scopedJobId: string,
    supersessionPolicy: TOcrTextSupersessionPolicy,
    replaceAllAcknowledged: boolean,
) {
    ocrProjectionPolicies.set(scopedJobId, {
        supersessionPolicy,
        replaceAllAcknowledged,
    });
}

function toOcrJobPhase(phase: string): TOcrJobProjectionPhase {
    return phase === 'queued'
        || phase === 'recognizing'
        || phase === 'applying'
        || phase === 'cancel-requested'
        || phase === 'preparing'
        || phase === 'model-prep'
        || phase === 'pdf-prep'
        || phase === 'dpi-inspection'
        || phase === 'page-size-probing'
        || phase === 'processing'
        || phase === 'merging'
        || phase === 'indexing'
        ? phase
        : 'recognizing';
}

export function getOcrJobProjection(senderId: number, requestId: string): IOcrJobProjectionState | null {
    const scopedJobId = toScopedOcrJobId(senderId, requestId);
    const state = documentOutputService.getState(scopedJobId);
    if (!state || state.operation !== 'ocr-projection') {
        return null;
    }
    const policy = ocrProjectionPolicies.get(scopedJobId);
    return {
        jobId: scopedJobId,
        requestId,
        status: state.status,
        phase: toOcrJobPhase(state.progress.phase),
        percent: state.progress.percent,
        ...(state.progress.current === undefined ? {} : {current: state.progress.current}),
        ...(state.progress.total === undefined ? {} : {total: state.progress.total}),
        ...(state.progress.error === undefined ? {} : {error: state.progress.error}),
        updatedAtMs: state.updatedAtMs,
        ...(policy ?? {}),
    };
}

export function subscribeOcrJobProjection(
    senderId: number,
    requestId: string,
    listener: (state: IOcrJobProjectionState) => void,
) {
    const scopedJobId = toScopedOcrJobId(senderId, requestId);
    return documentOutputService.subscribe(scopedJobId, () => {
        const projection = getOcrJobProjection(senderId, requestId);
        if (projection) {
            listener(projection);
        }
    });
}
