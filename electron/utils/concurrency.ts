import {
    availableParallelism,
    cpus,
} from 'os';
import { limitAsync } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';

function parsePositiveInt(value: string | undefined): number | null {
    if (!value) {
        return null;
    }
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function getCpuCount(): number {
    const count = typeof availableParallelism === 'function'
        ? availableParallelism()
        : cpus().length;
    return Math.max(1, count);
}

export function getOcrConcurrency(targetCount: number): number {
    const configured = parsePositiveInt(process.env.OCR_CONCURRENCY);
    const safeTargetCount = Math.max(1, targetCount);
    if (configured) {
        return clamp(configured, 1, safeTargetCount);
    }
    const cpuCount = getCpuCount();
    const defaultConcurrency = Math.min(cpuCount, 8);
    return clamp(defaultConcurrency, 1, safeTargetCount);
}

export function getTesseractThreadLimit(concurrency: number): number {
    const configured = parsePositiveInt(process.env.OCR_TESSERACT_THREADS);
    if (configured) {
        return configured;
    }
    const cpuCount = getCpuCount();
    return Math.max(1, Math.floor(cpuCount / Math.max(1, concurrency)));
}

export async function forEachConcurrent<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    if (items.length === 0) {
        return;
    }

    const workerCount = clamp(concurrency, 1, items.length);
    const limited = limitAsync(fn, workerCount);
    await Promise.all(items.map((item, index) => limited(item, index)));
}

export function getSequentialProgressPage(
    pages: Array<{ pageNumber: number }>,
    processedCount: number,
): number {
    if (pages.length === 0) {
        return 0;
    }
    const index = clamp(processedCount, 0, pages.length - 1);
    return pages[index]?.pageNumber ?? 0;
}
