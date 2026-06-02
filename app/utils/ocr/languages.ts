import { range } from 'es-toolkit/math';
import type { TDocumentRef } from '@contracts/platformApi';

export type TOcrPageRange = 'all' | 'current' | 'custom';

export interface IOcrSettings {
    pageRange: TOcrPageRange;
    customRange: string;
    selectedLanguages: string[];
}

export interface IOcrProgress {
    isRunning: boolean;
    phase: 'preparing' | 'processing';
    currentPage: number;
    totalPages: number;
    processedCount: number;
}

export interface IOcrQualityMetrics {
    totalWords: number;
    avgConfidence: number;
    lowConfidenceWords: number;
    successRate: number;
    pagesProcessed: number;
    dpiUsed: number;
    estimatedQuality: 'excellent' | 'good' | 'fair' | 'poor';
    recommendedDpi?: number;
    embedSuccess: boolean;
    embedError?: string;
}

export interface IOcrSearchablePdfResult {
    requestId: string;
    pdfPath: TDocumentRef;
    requiresCleanupAck: boolean;
}

export interface IOcrResults {
    pages: Map<number, string>;
    languages: string[];
    completedAt: number | null;
    searchablePdfResult: IOcrSearchablePdfResult | null;
    metrics?: IOcrQualityMetrics;
}

export function parsePageRange(
    rangeType: TOcrPageRange,
    customRange: string,
    currentPage: number,
    totalPages: number,
): number[] {
    if (rangeType === 'current') {
        return [currentPage];
    }

    if (rangeType === 'all') {
        return range(1, totalPages + 1);
    }

    const pages = new Set<number>();
    const parts = customRange.split(',').map(p => p.trim());

    for (const part of parts) {
        if (part.includes('-')) {
            const segments = part.split('-');
            const startStr = segments[0];
            const endStr = segments[1];
            if (startStr && endStr) {
                const start = parseInt(startStr.trim(), 10);
                const end = parseInt(endStr.trim(), 10);
                if (!isNaN(start) && !isNaN(end)) {
                    range(Math.max(1, start), Math.min(totalPages, end) + 1)
                        .forEach(page => pages.add(page));
                }
            }
        } else {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= totalPages) {
                pages.add(num);
            }
        }
    }

    return Array.from(pages).sort((a, b) => a - b);
}
