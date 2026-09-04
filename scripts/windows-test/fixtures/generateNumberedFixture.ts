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

export const NUMBERED_FIXTURE_PAGE_COUNT = 12;

export const NUMBERED_FIXTURE_PACK_ID = 'F01';

export function numberedFixtureMarkers(pageCount = NUMBERED_FIXTURE_PAGE_COUNT) {
    return Array.from(
        { length: pageCount },
        (_unused, index) => formatPageMarker(NUMBERED_FIXTURE_PACK_ID, index + 1),
    );
}

export interface INumberedFixtureOptions {
    pageCount?: number;
    packId?: string;
}

export async function generateNumberedFixture(options: INumberedFixtureOptions = {}) {
    const pageCount = options.pageCount ?? NUMBERED_FIXTURE_PAGE_COUNT;
    const packId = options.packId ?? NUMBERED_FIXTURE_PACK_ID;
    const document = await PDFDocument.create();
    applyDeterministicDocumentMetadata(document, {
        title: `EVB Windows lane numbered fixture ${packId}`,
        subject: 'Per-page identity for delete, save, print and reopen ordering checks',
        keywords: [
            'evb',
            'windows-test',
            packId,
        ],
    });
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < pageCount; index += 1) {
        const page = document.addPage([
            FIXTURE_PAGE_WIDTH,
            FIXTURE_PAGE_HEIGHT,
        ]);
        drawFixturePageMarks({
            page,
            font,
            marker: formatPageMarker(packId, index + 1),
            pageIndex: index,
            pageCount,
        });
    }
    return document.save({ useObjectStreams: false });
}
