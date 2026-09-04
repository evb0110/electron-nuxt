import { PDFDocument } from 'pdf-lib';
import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import {
    createOracleResult,
    describeError,
} from '@scripts/windows-test/oracles/oracleResult';

export const PDF_STRUCTURE_ORACLE_ID = 'pdf-structure';

export const PAGE_COUNT_ORACLE_ID = 'page-count';

export const PDF_STRUCTURE_ORACLE_VERSION = 'pdf-lib@1.17';

const SIZE_TOLERANCE_POINTS = 0.5;

export interface IPdfPageGeometry {
    width: number;
    height: number;
    rotation: number;
}

export interface IPdfStructureObservation {
    pageCount: number;
    pages: IPdfPageGeometry[];
    annotationCount: number;
    title: string | null;
    subject: string | null;
    producer: string | null;
}

export interface IPdfStructureExpectation {
    pageCount?: number;
    pageGeometry?: readonly IPdfPageGeometry[];
    annotationCount?: number;
    title?: string;
    subject?: string;
}

function readMetadataString(read: () => string | undefined) {
    try {
        return read() ?? null;
    } catch {
        return null;
    }
}

export async function inspectPdfStructure(bytes: Uint8Array): Promise<IPdfStructureObservation> {
    const document = await PDFDocument.load(bytes, {
        updateMetadata: false,
        throwOnInvalidObject: false,
    });
    const pages = document.getPages();
    let annotationCount = 0;
    for (const page of pages) {
        annotationCount += page.node.Annots()?.size() ?? 0;
    }
    return {
        pageCount: pages.length,
        pages: pages.map((page) => {
            const size = page.getSize();
            return {
                width: size.width,
                height: size.height,
                rotation: page.getRotation().angle,
            };
        }),
        annotationCount,
        title: readMetadataString(() => document.getTitle()),
        subject: readMetadataString(() => document.getSubject()),
        producer: readMetadataString(() => document.getProducer()),
    };
}

function collectGeometryFailures(
    observation: IPdfStructureObservation,
    expectation: IPdfStructureExpectation,
) {
    const failures: string[] = [];
    if (expectation.pageCount !== undefined && observation.pageCount !== expectation.pageCount) {
        failures.push(`page count is ${observation.pageCount}, expected ${expectation.pageCount}`);
    }
    if (expectation.annotationCount !== undefined && observation.annotationCount !== expectation.annotationCount) {
        failures.push(`annotation count is ${observation.annotationCount}, expected ${expectation.annotationCount}`);
    }
    if (expectation.title !== undefined && observation.title !== expectation.title) {
        failures.push(`title is ${JSON.stringify(observation.title)}, expected ${JSON.stringify(expectation.title)}`);
    }
    if (expectation.subject !== undefined && observation.subject !== expectation.subject) {
        failures.push(`subject is ${JSON.stringify(observation.subject)}, expected ${JSON.stringify(expectation.subject)}`);
    }
    const expectedGeometry = expectation.pageGeometry;
    if (expectedGeometry === undefined) {
        return failures;
    }
    if (expectedGeometry.length !== observation.pages.length) {
        failures.push(`geometry list covers ${expectedGeometry.length} pages but the document has ${observation.pages.length}`);
        return failures;
    }
    expectedGeometry.forEach((expected, index) => {
        const actual = observation.pages[index];
        if (actual === undefined) {
            return;
        }
        if (Math.abs(actual.width - expected.width) > SIZE_TOLERANCE_POINTS
            || Math.abs(actual.height - expected.height) > SIZE_TOLERANCE_POINTS) {
            failures.push(
                `page ${index + 1} is ${actual.width}x${actual.height}, expected ${expected.width}x${expected.height}`,
            );
        }
        if (actual.rotation !== expected.rotation) {
            failures.push(`page ${index + 1} rotation is ${actual.rotation}, expected ${expected.rotation}`);
        }
    });
    return failures;
}

export async function evaluatePdfStructure(
    bytes: Uint8Array,
    expectation: IPdfStructureExpectation,
    oracleId: string = PDF_STRUCTURE_ORACLE_ID,
): Promise<IOracleResult> {
    let observation: IPdfStructureObservation;
    try {
        observation = await inspectPdfStructure(bytes);
    } catch (error) {
        return createOracleResult({
            oracleId,
            oracleVersion: PDF_STRUCTURE_ORACLE_VERSION,
            status: 'failed',
            detail: `The document could not be parsed: ${describeError(error)}`,
            observations: { bytes: bytes.byteLength },
        });
    }
    const asserted = [
        expectation.pageCount,
        expectation.pageGeometry,
        expectation.annotationCount,
        expectation.title,
        expectation.subject,
    ].some(value => value !== undefined);
    if (!asserted) {
        return createOracleResult({
            oracleId,
            oracleVersion: PDF_STRUCTURE_ORACLE_VERSION,
            status: 'inconclusive',
            detail: 'The expectation asserts no structural property, so the document was not judged.',
            observations: { ...observation },
        });
    }
    const failures = collectGeometryFailures(observation, expectation);
    return createOracleResult({
        oracleId,
        oracleVersion: PDF_STRUCTURE_ORACLE_VERSION,
        status: failures.length === 0 ? 'passed' : 'failed',
        detail: failures.length === 0
            ? `Structure matches the expectation across ${observation.pageCount} pages.`
            : failures.join('; '),
        observations: { ...observation },
    });
}

export async function evaluatePageCount(
    bytes: Uint8Array,
    expectedPageCount: number,
): Promise<IOracleResult> {
    return evaluatePdfStructure(bytes, { pageCount: expectedPageCount }, PAGE_COUNT_ORACLE_ID);
}
