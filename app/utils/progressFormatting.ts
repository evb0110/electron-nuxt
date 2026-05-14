import { clamp } from 'es-toolkit/math';

export function displayProcessedCount(processed: number, total: number) {
    if (total <= 0) {
        return 0;
    }
    const rounded = Math.round(processed);
    return clamp(rounded, 0, total);
}

export function formatEtaDuration(etaMs: number | null) {
    if (etaMs === null || !Number.isFinite(etaMs) || etaMs <= 0) {
        return null;
    }
    const totalSeconds = Math.max(1, Math.round(etaMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}
