export async function measureOperationPhase<T>(operation: () => Promise<T>, onComplete: (durationMs: number) => void): Promise<T> {
    const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
    try { return await operation(); }
    finally { onComplete(Math.round(((typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt) * 10) / 10); }
}
