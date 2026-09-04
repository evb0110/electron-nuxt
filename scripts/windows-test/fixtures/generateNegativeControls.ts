import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';
import {
    applyDeterministicDocumentMetadata,
    drawFixturePageMarks,
    FIXTURE_PAGE_HEIGHT,
    FIXTURE_PAGE_WIDTH,
    formatPageMarker,
} from '@scripts/windows-test/fixtures/fixtureDocumentBuilders';
import {
    generateNumberedFixture,
    NUMBERED_FIXTURE_PACK_ID,
    NUMBERED_FIXTURE_PAGE_COUNT,
} from '@scripts/windows-test/fixtures/generateNumberedFixture';

export const NEGATIVE_CONTROL_PACK_ID = 'F05';

export interface IWindowsNegativeControls {
    blankSinglePage: Uint8Array;
    wrongPageMarkers: Uint8Array;
    truncated: Uint8Array;
    corruptSidecar: string;
}

/**
 * Structurally valid and openable, but with nothing drawn: this is the control
 * that the blank-print regression produced, and every render oracle must reject
 * it.
 */
export async function generateBlankControl() {
    const document = await PDFDocument.create();
    applyDeterministicDocumentMetadata(document, {
        title: 'EVB Windows lane blank negative control',
        subject: 'Structurally valid one-page PDF with no drawn content',
        keywords: [
            'evb',
            'windows-test',
            'negative-control',
        ],
    });
    document.addPage([
        FIXTURE_PAGE_WIDTH,
        FIXTURE_PAGE_HEIGHT,
    ]);
    return document.save({ useObjectStreams: false });
}

/**
 * Every page carries a real F01 marker, but never the marker that belongs to
 * that page, so a page-count-only oracle passes while a marker oracle fails.
 */
export async function generateWrongMarkerControl(pageCount = NUMBERED_FIXTURE_PAGE_COUNT) {
    const document = await PDFDocument.create();
    applyDeterministicDocumentMetadata(document, {
        title: 'EVB Windows lane wrong-page-marker negative control',
        subject: 'Correct page count with rotated page markers',
        keywords: [
            'evb',
            'windows-test',
            'negative-control',
        ],
    });
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < pageCount; index += 1) {
        const page = document.addPage([
            FIXTURE_PAGE_WIDTH,
            FIXTURE_PAGE_HEIGHT,
        ]);
        const rotatedPageNumber = ((index + 1) % pageCount) + 1;
        drawFixturePageMarks({
            page,
            font,
            marker: formatPageMarker(NUMBERED_FIXTURE_PACK_ID, rotatedPageNumber),
            pageIndex: index,
            pageCount,
        });
    }
    return document.save({ useObjectStreams: false });
}

export async function generateTruncatedControl() {
    const complete = await generateNumberedFixture();
    return complete.slice(0, Math.floor(complete.length / 2));
}

export function generateCorruptSidecarControl() {
    // A sidecar that parses as JSON but violates the revision contract: the
    // pending journal points at a revision the identity record never saw.
    return `${JSON.stringify({
        schemaVersion: 1,
        documentId: 'evb-negative-control',
        revisionToken: 'rev-000000',
        pendingJournal: {
            revisionToken: 'rev-999999',
            stagedContentSha256: '0'.repeat(64),
            committedAt: null,
        },
        pageIdentities: [],
    }, null, 4)}\n`;
}

export async function generateNegativeControls(): Promise<IWindowsNegativeControls> {
    return {
        blankSinglePage: await generateBlankControl(),
        wrongPageMarkers: await generateWrongMarkerControl(),
        truncated: await generateTruncatedControl(),
        corruptSidecar: generateCorruptSidecarControl(),
    };
}
