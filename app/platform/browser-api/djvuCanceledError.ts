export class DjvuCanceledError extends Error {
    constructor() {
        super('DjVu conversion canceled');
        this.name = 'DjvuCanceledError';
    }
}

export function throwIfDjvuCanceled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new DjvuCanceledError();
    }
}
