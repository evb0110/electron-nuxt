import type { TDocumentRef } from '@contracts/documentRef';
import type { TOcrProgressPhase } from '@contracts/electronApiOcr';

export type TOcrPageRange = 'all' | 'current' | 'custom';

export interface IOcrSettings {
    pageRange: TOcrPageRange;
    customRange: string;
    selectedLanguages: string[];
}

export interface IOcrUiProgress {
    isRunning: boolean;
    phase: TOcrProgressPhase;
    currentPage: number;
    totalPages: number;
    processedCount: number;
    phaseProgress: number | null;
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
