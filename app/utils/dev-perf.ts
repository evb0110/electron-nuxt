interface IDevPerfDetails { [key: string]: unknown; }

function isDevPerfEnabled() {
    return import.meta.dev && typeof performance !== 'undefined' && typeof console !== 'undefined';
}

function logDevPerf(label: string, startedAt: number, thresholdMs: number, details?: IDevPerfDetails) {
    if (!isDevPerfEnabled()) {
        return;
    }

    const durationMs = performance.now() - startedAt;
    if (durationMs < thresholdMs) {
        return;
    }

    console.debug(`[perf] ${label}`, {
        durationMs: Math.round(durationMs * 100) / 100,
        ...details,
    });
}

export function measureDevPerf<T>(
    label: string,
    run: () => T,
    options: {
        thresholdMs?: number;
        details?: IDevPerfDetails;
    } = {},
): T {
    if (!isDevPerfEnabled()) {
        return run();
    }

    const startedAt = performance.now();
    try {
        return run();
    } finally {
        logDevPerf(label, startedAt, options.thresholdMs ?? 16, options.details);
    }
}

export async function measureDevPerfAsync<T>(
    label: string,
    run: () => Promise<T>,
    options: {
        thresholdMs?: number;
        details?: IDevPerfDetails;
    } = {},
): Promise<T> {
    if (!isDevPerfEnabled()) {
        return run();
    }

    const startedAt = performance.now();
    try {
        return await run();
    } finally {
        logDevPerf(label, startedAt, options.thresholdMs ?? 16, options.details);
    }
}
