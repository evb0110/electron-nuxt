import { isRecord } from '@contracts/runtimeGuards';
import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import {
    createOracleResult,
    describeError,
} from '@scripts/windows-test/oracles/oracleResult';
import {
    isPdfjsRuntimeUnavailable,
    loadPdfjsDocument,
} from '@scripts/windows-test/oracles/pdfjsNodeRuntime';
import {evaluateOcrPageMarkers} from '@scripts/windows-test/oracles/ocrPageMarkerOracle';
import type { TOcrProcessRunner } from '@scripts/windows-test/oracles/ocrPageMarkerOracle';
import {collectMarkerFailures} from '@scripts/windows-test/oracles/collectMarkerFailures';

export const PAGE_MARKER_ORACLE_ID = 'page-markers';

export const PAGE_MARKER_ORACLE_VERSION = 'pdfjs-dist@6.3.311-text-content';

export interface IPageMarkerExpectation {
    repositoryRoot: string;
    expectedMarkers: readonly string[];
    /** Additional markers that must not appear anywhere in the document. */
    forbiddenMarkers?: readonly string[];
    /** OCR is reserved for rasterized print artifacts. Text extraction remains the default. */
    mode?: 'text' | 'ocr';
    tesseractPath?: string;
    processRunner?: TOcrProcessRunner;
}

export interface IPageTextObservation {
    pageNumber: number;
    text: string;
}

function readItemText(item: unknown) {
    if (isRecord(item) && typeof item.str === 'string') {
        return item.str;
    }
    return '';
}

export async function extractPageTexts(
    bytes: Uint8Array,
    repositoryRoot: string,
): Promise<IPageTextObservation[]> {
    const document = await loadPdfjsDocument(bytes, { repositoryRoot });
    try {
        const observations: IPageTextObservation[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            observations.push({
                pageNumber,
                text: content.items.map(readItemText).join(' '),
            });
            page.cleanup();
        }
        return observations;
    } finally {
        await document.destroy();
    }
}

export async function evaluatePageMarkers(
    bytes: Uint8Array,
    expectation: IPageMarkerExpectation,
): Promise<IOracleResult> {
    if (expectation.mode === 'ocr') {
        return evaluateOcrPageMarkers(bytes, expectation);
    }
    let observations: IPageTextObservation[];
    try {
        observations = await extractPageTexts(bytes, expectation.repositoryRoot);
    } catch (error) {
        return createOracleResult({
            oracleId: PAGE_MARKER_ORACLE_ID,
            oracleVersion: PAGE_MARKER_ORACLE_VERSION,
            status: isPdfjsRuntimeUnavailable(error) ? 'inconclusive' : 'failed',
            detail: `Text extraction failed: ${describeError(error)}`,
            observations: { bytes: bytes.byteLength },
        });
    }
    const failures = collectMarkerFailures(
        observations,
        expectation.expectedMarkers,
        expectation.forbiddenMarkers,
        (marker, observation, index) => observation.text.includes(marker)
            ? undefined
            : `page ${index + 1} does not carry ${marker}; extracted ${JSON.stringify(observation.text.slice(0, 80))}`,
    );
    return createOracleResult({
        oracleId: PAGE_MARKER_ORACLE_ID,
        oracleVersion: PAGE_MARKER_ORACLE_VERSION,
        status: failures.length === 0 ? 'passed' : 'failed',
        detail: failures.length === 0
            ? `All ${expectation.expectedMarkers.length} markers appear on their expected pages in order.`
            : failures.join('; '),
        observations: { pages: observations },
    });
}
