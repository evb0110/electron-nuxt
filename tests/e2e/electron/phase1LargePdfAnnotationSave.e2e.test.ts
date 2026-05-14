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
} from './helpers/sessionHarness';
import {
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from './helpers/viewerHelpers';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const REOPEN_NOTE_TIMEOUT_MS = 45_000;
const RENDERER_SNAPSHOT_TIMEOUT_MS = 5_000;
const runLargePdfE2E = process.env.EVB_E2E_LARGE_PDF === '1' && Boolean(resolveLargePdfFixturePath());
const largePdfIt = runLargePdfE2E ? it : it.skip;

interface INoteWindowSnapshot {
    textareaValues: string[];
    noteWindowCount: number;
    pageCount: number;
    renderedContentCount: number;
    markerLabels: string[];
    activeHostVisible: boolean;
    saveState: string | null;
    errorText: string | null;
}

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
    const startedAt = Date.now();
    let lastSnapshot: INoteWindowSnapshot | null = null;
    let lastError: Error | null = null;

    while (Date.now() - startedAt < REOPEN_NOTE_TIMEOUT_MS) {
        try {
            lastSnapshot = await withTimeout(
                readNoteWindowSnapshot(page),
                RENDERER_SNAPSHOT_TIMEOUT_MS,
                'Renderer did not respond while waiting for the reopened large-PDF note',
            );
            if (lastSnapshot.textareaValues.includes(expectedText)) {
                return;
            }
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            break;
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
        });
    }

    const detail = lastSnapshot
        ? JSON.stringify(lastSnapshot)
        : (lastError?.message ?? 'no renderer snapshot available');
    throw new Error(`Expected reopened large-PDF note text within ${REOPEN_NOTE_TIMEOUT_MS}ms. Last state: ${detail}`);
}

async function openPersistedNoteMarker(page: Page, expectedText: string) {
    const startedAt = Date.now();
    let lastSnapshot: INoteWindowSnapshot | null = null;
    let lastError: Error | null = null;

    while (Date.now() - startedAt < REOPEN_NOTE_TIMEOUT_MS) {
        try {
            const clickedLabel = await withTimeout(
                clickPersistedNoteMarker(page, expectedText),
                RENDERER_SNAPSHOT_TIMEOUT_MS,
                'Renderer did not respond while locating the reopened large-PDF note marker',
            );
            if (clickedLabel) {
                return;
            }
            lastSnapshot = await withTimeout(
                readNoteWindowSnapshot(page),
                RENDERER_SNAPSHOT_TIMEOUT_MS,
                'Renderer did not respond while snapshotting reopened large-PDF markers',
            );
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            break;
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
        });
    }

    const detail = lastSnapshot
        ? JSON.stringify(lastSnapshot)
        : (lastError?.message ?? 'no renderer snapshot available');
    throw new Error(`Expected reopened large-PDF note marker within ${REOPEN_NOTE_TIMEOUT_MS}ms. Last state: ${detail}`);
}

async function clickPersistedNoteMarker(page: Page, expectedText: string) {
    return page.evaluate((text: string): string | null => {
        const markers = Array.from(document.querySelectorAll<HTMLButtonElement>('.pdf-comment-marker-button'));
        const target = markers.find((marker) =>
            marker.getAttribute('aria-label')?.includes(text),
        );
        if (!target) {
            return null;
        }
        const label = target.getAttribute('aria-label') ?? '';
        target.click();
        return label;
    }, expectedText);
}

async function readNoteWindowSnapshot(page: Page) {
    return page.evaluate((): INoteWindowSnapshot => {
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const activeHostRect = activeHost?.getBoundingClientRect();
        const activeHostStyle = activeHost ? window.getComputedStyle(activeHost) : null;
        const errorText = document.querySelector<HTMLElement>('[role="alert"], .app-error-boundary, .app-error')?.innerText?.trim() ?? null;
        const markers = Array.from(document.querySelectorAll<HTMLButtonElement>('.pdf-comment-marker-button'));
        return {
            textareaValues: Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'))
                .map(textarea => textarea.value),
            noteWindowCount: document.querySelectorAll('.note-window').length,
            pageCount: document.querySelectorAll('.page_container').length,
            renderedContentCount: document.querySelectorAll('.page_canvas canvas, .text-layer span, .textLayer span').length,
            markerLabels: markers.map(marker => marker.getAttribute('aria-label') ?? ''),
            activeHostVisible: Boolean(
                activeHostRect
                && activeHostStyle
                && activeHostRect.width > 100
                && activeHostRect.height > 100
                && activeHostStyle.display !== 'none'
                && activeHostStyle.visibility !== 'hidden',
            ),
            saveState: document.querySelector<HTMLButtonElement>('.status-save-dot-button')?.getAttribute('aria-label') ?? null,
            errorText,
        };
    });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    promise.catch(() => undefined);
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`${message} within ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

async function waitForCleanSaveState(page: Page) {
    const deadline = Date.now() + LARGE_PDF_TIMEOUT_MS;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        try {
            const isClean = await page.evaluate(() => {
                const saveDot = document.querySelector<HTMLButtonElement>('.status-save-dot-button');
                return saveDot?.getAttribute('aria-label') === 'All changes saved';
            });
            if (isClean) {
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Save state did not become clean within ${LARGE_PDF_TIMEOUT_MS}ms: ${String(lastError ?? 'timed out')}`);
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
        await openPersistedNoteMarker(page, firstText);
        await waitForOpenNoteText(page, firstText);
    }, LARGE_PDF_TIMEOUT_MS);
});
