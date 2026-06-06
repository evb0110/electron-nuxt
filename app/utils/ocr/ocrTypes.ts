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
