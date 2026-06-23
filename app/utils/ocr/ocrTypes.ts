import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TOcrProgressPhase,
    TOcrPreprocessingMode,
    TOcrQualityProfile,
} from '@contracts/electronApiOcr';

export type TOcrPageRange = 'all' | 'current' | 'custom';

export interface IOcrSettings {
    pageRange: TOcrPageRange;
    customRange: string;
    selectedLanguages: string[];
    qualityProfile: TOcrQualityProfile;
    preprocessingMode: TOcrPreprocessingMode;
    pageSegmentationMode: number | null;
}

export interface IOcrUiProgress {
    isRunning: boolean;
    phase: TOcrProgressPhase;
    currentPage: number;
    totalPages: number;
    processedCount: number;
    phaseProgress: number | null;
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
}
