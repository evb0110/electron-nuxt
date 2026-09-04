import {
    PDFDocument,
    rgb,
    StandardFonts,
} from 'pdf-lib';
import {
    applyDeterministicDocumentMetadata,
    drawFixturePageMarks,
    FIXTURE_PAGE_HEIGHT,
    FIXTURE_PAGE_WIDTH,
    formatPageMarker,
} from '@scripts/windows-test/fixtures/fixtureDocumentBuilders';

export const FONTS_FIXTURE_PACK_ID = 'F04';

export interface IFontsFixtureScript {
    id: string;
    intendedText: string;
    /**
     * pdf-lib can only embed a custom font through `@pdf-lib/fontkit`, which is
     * not a dependency of this repository, so the standard fonts cap the drawn
     * text at WinAnsi. The Unicode string stays in `intendedText` and in the
     * fixture file names, and the drawn line is a labelled transliteration.
     */
    winAnsiText: string;
    unicodeFileName: string;
}

export const FONTS_FIXTURE_SCRIPTS: readonly IFontsFixtureScript[] = [
    {
        id: 'EVB-F04-LATIN-01',
        intendedText: 'Latin baseline with ligature office fi fl',
        winAnsiText: 'Latin baseline with ligature office fi fl',
        unicodeFileName: 'evb-f04-latin-baseline.pdf',
    },
    {
        id: 'EVB-F04-CYR-01',
        intendedText: 'Кириллица: приветствие и проверка шрифта',
        winAnsiText: 'Kirillica: privetstvie i proverka shrifta',
        unicodeFileName: 'evb-f04-кириллица-проверка.pdf',
    },
    {
        id: 'EVB-F04-RTL-01',
        intendedText: 'عربى: اختبار اتجاه النص من اليمين',
        winAnsiText: 'Arabic RTL direction probe (transliterated)',
        unicodeFileName: 'evb-f04-عربى-اختبار.pdf',
    },
    {
        id: 'EVB-F04-CJK-01',
        intendedText: '日本語と中文の文字化けテスト',
        winAnsiText: 'CJK glyph fallback probe (transliterated)',
        unicodeFileName: 'evb-f04-日本語-测试.pdf',
    },
];

export function fontsFixtureMarkers() {
    return FONTS_FIXTURE_SCRIPTS.map((_unused, index) => formatPageMarker(FONTS_FIXTURE_PACK_ID, index + 1));
}

export function fontsFixtureUnicodeFileNames() {
    return FONTS_FIXTURE_SCRIPTS.map(script => script.unicodeFileName);
}

export async function generateFontsFixture() {
    const pageCount = FONTS_FIXTURE_SCRIPTS.length;
    const document = await PDFDocument.create();
    applyDeterministicDocumentMetadata(document, {
        title: 'EVB Windows lane font and language fixture F04',
        subject: 'Cyrillic, RTL and CJK obligations with WinAnsi-safe drawn text',
        keywords: [
            'evb',
            'windows-test',
            'F04',
        ],
    });
    const font = await document.embedFont(StandardFonts.Helvetica);
    FONTS_FIXTURE_SCRIPTS.forEach((script, index) => {
        const page = document.addPage([
            FIXTURE_PAGE_WIDTH,
            FIXTURE_PAGE_HEIGHT,
        ]);
        drawFixturePageMarks({
            page,
            font,
            marker: formatPageMarker(FONTS_FIXTURE_PACK_ID, index + 1),
            pageIndex: index,
            pageCount,
        });
        page.drawText(script.id, {
            x: 52,
            y: 420,
            size: 16,
            font,
            color: rgb(0.05, 0.05, 0.05),
        });
        page.drawText(script.winAnsiText, {
            x: 52,
            y: 390,
            size: 13,
            font,
            color: rgb(0.15, 0.15, 0.15),
        });
    });
    return document.save({ useObjectStreams: false });
}
