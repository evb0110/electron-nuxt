export function isWorkerMessageRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function isFiniteWorkerMessageNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
