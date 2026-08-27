import type {IPdfConformanceProfile} from '@contracts/pdfConformance';
import {
    analyzePdfConformancePath,
    type IPdfConformancePathAnalysisOptions,
} from '@electron/features/documents/main/pdfConformancePathAnalysis';

/**
 * Analyze a path without creating a JavaScript value for the complete PDF.
 * qpdf reads the source structurally with stream bodies omitted, and marker
 * evidence is collected through bounded range reads.
 */
export function analyzePdfConformanceFileDirect(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfConformanceProfile> {
    return analyzePdfConformancePath(filePath, options);
}
