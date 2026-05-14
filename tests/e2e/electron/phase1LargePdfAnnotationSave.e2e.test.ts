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
const runLargePdfAnnotationSaveE2E = runLargePdfE2E && process.env.EVB_E2E_LARGE_PDF_ANNOTATION_SAVE === '1';
const largePdfIt = runLargePdfAnnotationSaveE2E ? it : it.skip;

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

interface IVueWorkspaceHost extends HTMLElement {__vueParentComponent?: {
    exposed?: unknown;
    setupState?: {
        mountedWorkspace?: { value?: unknown; };
        workspaceRef?: { value?: unknown; };
    };
};}

function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

async function readPdfNoteContents(filePath: string) {
    const doc = await PDFDocument.load(readFileSync(filePath), { updateMetadata: false });
    const notes: Array<{
        contents: string;
        pageIndex: number;
        popup: string;
        ref: string;
        subtype: string;
    }> = [];

    for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex += 1) {
        const annots = doc.getPage(pageIndex).node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const ref = annots.get(index);
            if (!(ref instanceof PDFRef)) {
                continue;
            }
            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }
            const contents = getPdfStringValue(dict.get(PDFName.of('Contents')));
            const subtype = dict.get(PDFName.of('Subtype'))?.toString() ?? '';
            if (!contents || (subtype !== '/FreeText' && subtype !== '/Text')) {
                continue;
            }

            notes.push({
                ref: String(ref),
                pageIndex,
                contents,
                popup: String(dict.get(PDFName.of('Popup')) ?? ''),
                subtype,
            });
        }
    }

    return notes;
}

async function placePageNote(page: Page, text: string) {
    const point = await page.evaluate(async () => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host: IVueWorkspaceHost | null = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const component = host?.__vueParentComponent;
        const candidates = [
            component?.exposed,
            component?.setupState?.mountedWorkspace?.value,
            component?.setupState?.workspaceRef?.value,
        ];
        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object') {
                continue;
            }
            const workspace = candidate as { handleQuickNote?: () => void | Promise<void>; };
            if (typeof workspace.handleQuickNote === 'function') {
                await workspace.handleQuickNote();
                break;
            }
        }

        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
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
    await page.type('textarea.note-window__textarea', text, { delay: 5 });
    const typedState = await page.evaluate((noteText: string) => {
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea.note-window__textarea');
        const saveDot = document.querySelector<HTMLButtonElement>('.status-save-dot-button');
        return {
            value: textarea?.value ?? null,
            includesText: Boolean(textarea?.value.includes(noteText)),
            saveLabel: saveDot?.getAttribute('aria-label') ?? null,
        };
    }, text);
    if (!typedState.includesText) {
        throw new Error(`Large PDF note text was not entered: ${JSON.stringify(typedState)}`);
    }
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

        console.info('[large-pdf-e2e] reading saved bytes');
        const notes = await readPdfNoteContents(fixturePath);
        expect(notes.filter(note => note.contents === firstText)).toHaveLength(1);

        console.info('[large-pdf-e2e] reopening fixture');
        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await openPersistedNoteMarker(page, firstText);
        await waitForOpenNoteText(page, firstText);
    }, LARGE_PDF_TIMEOUT_MS);
});
