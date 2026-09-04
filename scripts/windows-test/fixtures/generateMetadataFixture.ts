import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';
import {
    addLinkAnnotation,
    addNamedDestinations,
    addOutline,
    addPageLabels,
    addTextAnnotation,
    applyDeterministicDocumentMetadata,
    drawFixturePageMarks,
    FIXTURE_PAGE_HEIGHT,
    FIXTURE_PAGE_WIDTH,
    formatPageMarker,
} from '@scripts/windows-test/fixtures/fixtureDocumentBuilders';

export const METADATA_FIXTURE_PAGE_COUNT = 6;

export const METADATA_FIXTURE_PACK_ID = 'F02';

export const METADATA_FIXTURE_NAMED_DESTINATIONS = [
    'evb-f02-cover',
    'evb-f02-middle',
    'evb-f02-back',
] as const;

export const METADATA_FIXTURE_OUTLINE_TITLES = [
    'F02 cover',
    'F02 middle section',
    'F02 back matter',
] as const;

export const METADATA_FIXTURE_FORM_FIELD_NAME = 'evbF02ReviewerName';

export function metadataFixtureMarkers(pageCount = METADATA_FIXTURE_PAGE_COUNT) {
    return Array.from(
        { length: pageCount },
        (_unused, index) => formatPageMarker(METADATA_FIXTURE_PACK_ID, index + 1),
    );
}

export async function generateMetadataFixture() {
    const pageCount = METADATA_FIXTURE_PAGE_COUNT;
    const document = await PDFDocument.create();
    applyDeterministicDocumentMetadata(document, {
        title: 'EVB Windows lane metadata fixture F02',
        subject: 'Bookmarks, named destinations, links, annotations and a form field',
        keywords: [
            'evb',
            'windows-test',
            'F02',
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
            marker: formatPageMarker(METADATA_FIXTURE_PACK_ID, index + 1),
            pageIndex: index,
            pageCount,
        });
    }

    addPageLabels(document, 2);
    addNamedDestinations(document, [
        {
            name: METADATA_FIXTURE_NAMED_DESTINATIONS[0],
            pageIndex: 0,
        },
        {
            name: METADATA_FIXTURE_NAMED_DESTINATIONS[1],
            pageIndex: Math.floor(pageCount / 2),
        },
        {
            name: METADATA_FIXTURE_NAMED_DESTINATIONS[2],
            pageIndex: pageCount - 1,
        },
    ]);
    addOutline(document, [
        {
            title: METADATA_FIXTURE_OUTLINE_TITLES[0],
            pageIndex: 0,
        },
        {
            title: METADATA_FIXTURE_OUTLINE_TITLES[1],
            pageIndex: Math.floor(pageCount / 2),
        },
        {
            title: METADATA_FIXTURE_OUTLINE_TITLES[2],
            pageIndex: pageCount - 1,
        },
    ]);
    addLinkAnnotation(document, {
        pageIndex: 0,
        targetPageIndex: pageCount - 1,
        rect: [
            52,
            FIXTURE_PAGE_HEIGHT - 200,
            300,
            FIXTURE_PAGE_HEIGHT - 175,
        ],
    });
    addTextAnnotation(document, {
        pageIndex: 1,
        contents: 'EVB-F02-NOTE-01 persistence probe',
        rect: [
            360,
            FIXTURE_PAGE_HEIGHT - 210,
            390,
            FIXTURE_PAGE_HEIGHT - 180,
        ],
    });

    const form = document.getForm();
    const field = form.createTextField(METADATA_FIXTURE_FORM_FIELD_NAME);
    field.setText('EVB-F02-FIELD-01');
    field.addToPage(document.getPage(2), {
        x: 52,
        y: 300,
        width: 240,
        height: 26,
        font,
    });

    return document.save({ useObjectStreams: false });
}
