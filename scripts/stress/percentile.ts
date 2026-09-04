/** Nearest-rank percentile; returns null for an empty sample. */
export function percentile(values: readonly number[], p: number) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const rank = Math.ceil((p / 100) * sorted.length);
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[index] ?? null;
}
