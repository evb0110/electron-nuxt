export class OcrRunCanceledError extends Error {
    constructor() {
        super('OCR canceled');
        this.name = 'OcrRunCanceledError';
    }
}

export type TOcrRunGuard = () => void;

export interface IOcrRunContext {
    runToken: symbol;
    runGeneration: number;
    ensureRunActive: TOcrRunGuard;
}

export interface IOcrRunLifecycle {
    beginRun: () => IOcrRunContext;
    isRunTokenActive: (runToken: symbol) => boolean;
    isRunActive: (runToken: symbol, runGeneration: number) => boolean;
    markRequestActive: (requestId: string) => void;
    clearActiveRequest: () => void;
    getActiveRequestId: () => string | null;
    cancelActiveRun: () => string | null;
    clearRunIfActive: (runToken: symbol) => boolean;
    beginCancelingRequest: (requestId: string) => void;
    finishCancelingRequest: (requestId: string) => boolean;
    getCancelingRequestId: () => string | null;
    shouldHandleLateCanceledResult: (requestId: string) => boolean;
}

export function createOcrRunLifecycle(): IOcrRunLifecycle {
    let cancelGeneration = 0;
    let activeRunToken: symbol | null = null;
    let activeRequestId: string | null = null;
    let cancelingRequestId: string | null = null;

    const isRunActive = (runToken: symbol, runGeneration: number) =>
        activeRunToken === runToken && runGeneration === cancelGeneration;

    const createRunGuard = (runToken: symbol, runGeneration: number): TOcrRunGuard => () => {
        if (!isRunActive(runToken, runGeneration)) {
            throw new OcrRunCanceledError();
        }
    };

    return {
        beginRun: () => {
            const runToken = Symbol('ocr-run');
            activeRunToken = runToken;
            const runGeneration = cancelGeneration;
            return {
                runToken,
                runGeneration,
                ensureRunActive: createRunGuard(runToken, runGeneration),
            };
        },
        isRunTokenActive: runToken => activeRunToken === runToken,
        isRunActive,
        markRequestActive: (requestId) => {
            activeRequestId = requestId;
        },
        clearActiveRequest: () => {
            activeRequestId = null;
        },
        getActiveRequestId: () => activeRequestId,
        cancelActiveRun: () => {
            const requestId = activeRequestId;
            cancelGeneration += 1;
            activeRunToken = null;
            return requestId;
        },
        clearRunIfActive: (runToken) => {
            if (activeRunToken !== runToken) {
                return false;
            }
            activeRunToken = null;
            activeRequestId = null;
            return true;
        },
        beginCancelingRequest: (requestId) => {
            cancelingRequestId = requestId;
            activeRequestId = requestId;
        },
        finishCancelingRequest: (requestId) => {
            if (cancelingRequestId !== requestId) {
                return false;
            }
            cancelingRequestId = null;
            activeRequestId = null;
            return true;
        },
        getCancelingRequestId: () => cancelingRequestId,
        shouldHandleLateCanceledResult: requestId => cancelingRequestId === requestId,
    };
}
