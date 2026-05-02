import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { readFileSync } from 'node:fs';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import type { Page } from 'puppeteer-core';
import {
    copyLargePdfFixture,
    resolveLargePdfFixturePath,
} from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/session-harness';
import {
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from './helpers/viewer-helpers';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const runLargePdfE2E = process.env.EVB_E2E_LARGE_PDF === '1' && Boolean(resolveLargePdfFixturePath());
const largePdfIt = runLargePdfE2E ? it : it.skip;

function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

async function readFirstPageNoteContents(filePath: string) {
    const doc = await PDFDocument.load(readFileSync(filePath), { updateMetadata: false });
    const annots = doc.getPage(0).node.Annots();
    const notes: Array<{
        contents: string;
        popup: string;
        ref: string;
    }> = [];

    if (!(annots instanceof PDFArray)) {
        return notes;
    }

    for (let index = 0; index < annots.size(); index += 1) {
        const ref = annots.get(index);
        if (!(ref instanceof PDFRef)) {
            continue;
        }
        const dict = doc.context.lookupMaybe(ref, PDFDict);
        if (!dict || dict.get(PDFName.of('Subtype'))?.toString() !== '/FreeText') {
            continue;
        }
        notes.push({
            ref: String(ref),
            contents: getPdfStringValue(dict.get(PDFName.of('Contents'))),
            popup: String(dict.get(PDFName.of('Popup')) ?? ''),
        });
    }

    return notes;
}

async function placePageNote(page: Page, text: string) {
    const point = await page.evaluate(() => {
        const noteButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => (
                button.getAttribute('aria-label') === 'Create notes from selected text or place one anywhere on a page.'
                && !button.disabled
            ));
        if (!noteButton) {
            return null;
        }
        noteButton.click();

        const pageElement = document.querySelector<HTMLElement>('.page_container--rendered')
            ?? document.querySelector<HTMLElement>('.page_container');
        if (!pageElement) {
            return null;
        }
        const rect = pageElement.getBoundingClientRect();
        return {
            x: rect.left + rect.width * 0.2,
            y: rect.top + rect.height * 0.2,
        };
    });
    if (!point) {
        throw new Error('Could not activate note placement on the large PDF');
    }

    await page.mouse.click(point.x, point.y);
    await page.waitForSelector('textarea.note-window__textarea', { timeout: 20_000 });
    await page.evaluate((noteText: string) => {
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea.note-window__textarea');
        if (!textarea) {
            return;
        }
        textarea.value = noteText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
}

async function waitForOpenNoteText(page: Page, expectedText: string) {
    await page.waitForFunction((text: string) => (
        Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'))
            .some(textarea => textarea.value === text)
    ), { timeout: LARGE_PDF_TIMEOUT_MS }, expectedText);
}

async function waitForCleanSaveState(page: Page) {
    await page.waitForFunction(() => {
        const saveDot = document.querySelector<HTMLButtonElement>('.status-save-dot-button');
        return saveDot?.getAttribute('aria-label') === 'All changes saved';
    }, { timeout: LARGE_PDF_TIMEOUT_MS });
}

describe('Electron E2E - Large PDF Annotation Save', () => {
    let session: IElectronE2ESession | null = null;

    beforeAll(async () => {
        if (!runLargePdfE2E) {
            return;
        }
        session = await startElectronE2ESession(`e2e-large-pdf-${Date.now()}`);
    }, LARGE_PDF_TIMEOUT_MS);

    afterAll(async () => {
        await session?.stop();
    });

    largePdfIt('creates, saves, and reopens a FreeText popup note on a large PDF', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Large PDF session was not initialized');
        }

        const fixturePath = copyLargePdfFixture(`large-pdf-note-${Date.now()}.pdf`);
        const firstText = `large pdf note ${Date.now()}`;

        console.info('[large-pdf-e2e] opening fixture');
        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);

        console.info('[large-pdf-e2e] placing note');
        await placePageNote(page, firstText);
        console.info('[large-pdf-e2e] saving note');
        await saveViaWindowHandle(page, LARGE_PDF_TIMEOUT_MS);
        await waitForCleanSaveState(page);

        console.info('[large-pdf-e2e] reading saved bytes');
        const notes = await readFirstPageNoteContents(fixturePath);
        expect(notes.filter(note => note.contents === firstText)).toHaveLength(1);

        console.info('[large-pdf-e2e] reopening fixture');
        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForOpenNoteText(page, firstText);
    }, LARGE_PDF_TIMEOUT_MS);
});
