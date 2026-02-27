export interface IWorkerRequestEnvelope<TPayload> {
    requestId: string;
    payload: TPayload;
}

export interface IWorkerProgressEnvelope<TProgress> {
    requestId: string;
    progress: TProgress;
}

export interface IWorkerSuccessEnvelope<TResult> {
    requestId: string;
    result: TResult;
}

export interface IWorkerErrorEnvelope {
    requestId: string;
    error: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function isString(value: unknown): value is string {
    return typeof value === 'string';
}
