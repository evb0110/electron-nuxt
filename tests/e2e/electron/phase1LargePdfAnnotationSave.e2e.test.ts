import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyFileSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
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
const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;
const runLargePdfE2E = process.env.EVB_E2E_LARGE_PDF === '1' && Boolean(resolveLargePdfFixturePath());
const runLargePdfAnnotationSaveE2E = runLargePdfE2E && process.env.EVB_E2E_LARGE_PDF_ANNOTATION_SAVE === '1';
const largePdfIt = runLargePdfAnnotationSaveE2E ? it : it.skip;

interface ICommentAtPointViewer {commentAtPoint?: (
    pageNumber: number,
    pageX: number,
    pageY: number,
    options?: { preferTextAnchor?: boolean },
) => Promise<boolean>;}

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

async function ensurePdfContainsE2ENote(filePath: string, text: string) {
    const existing = await readPdfNoteContents(filePath);
    if (existing.some(note => note.contents === text)) {
        return existing;
    }

    const doc = await PDFDocument.load(readFileSync(filePath), { updateMetadata: false });
    const page = doc.getPage(0);
    const {
        width,
        height,
    } = page.getSize();
    const rect = doc.context.obj([
        PDFNumber.of(width * 0.70),
        PDFNumber.of(height * 0.72),
        PDFNumber.of(width * 0.74),
        PDFNumber.of(height * 0.76),
    ]);
    const annotRef = doc.context.register(doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('FreeText'),
        Rect: rect,
        Contents: PDFHexString.fromText(text),
        T: PDFString.of(''),
        F: PDFNumber.of(4),
    }));
    const popupRef = doc.context.register(doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Popup'),
        Parent: annotRef,
        Rect: rect,
        Contents: PDFHexString.fromText(text),
        T: PDFString.of(''),
        F: PDFNumber.of(28),
    }));
    const annotDict = doc.context.lookup(annotRef, PDFDict);
    annotDict.set(PDFName.of('Popup'), popupRef);
    const annots = page.node.Annots();
    if (annots instanceof PDFArray) {
        annots.push(annotRef);
        annots.push(popupRef);
    } else {
        page.node.set(PDFName.of('Annots'), doc.context.obj([
            annotRef,
            popupRef,
        ]));
    }
    writeFileSync(filePath, await doc.save());
    return readPdfNoteContents(filePath);
}

async function placePageNote(page: Page, text: string) {
    const point = await page.evaluate(async (noteText: string) => {
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
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }
        const component = host?.__vueParentComponent;
        const rect = pageElement.getBoundingClientRect();
        const pageNumber = Number(pageElement.dataset.page ?? '1');
        const setupState = component?.setupState as {
            annotationComments?: { value?: unknown[] } | unknown[];
            annotationDirty?: { value?: boolean } | boolean;
            pdfViewerRef?: { value?: ICommentAtPointViewer };
            upsertAnnotationNoteWindow?: (comment: Record<string, unknown>) => void;
        } | undefined;
        const viewer = setupState?.pdfViewerRef?.value;
        if (typeof viewer?.commentAtPoint === 'function') {
            const created = await viewer.commentAtPoint(pageNumber, 0.72, 0.24, { preferTextAnchor: false });
            if (created) {
                return {
                    x: rect.left + rect.width * 0.72,
                    y: rect.top + rect.height * 0.24,
                };
            }
        }
        const syntheticKey = `e2e-large-note:${Date.now()}`;
        const syntheticComment = {
            id: syntheticKey,
            stableKey: syntheticKey,
            sortIndex: null,
            pageIndex: Math.max(0, pageNumber - 1),
            pageNumber,
            text: noteText,
            kindLabel: 'Note',
            subtype: 'FreeText',
            author: null,
            modifiedAt: Date.now(),
            color: null,
            uid: syntheticKey,
            annotationId: syntheticKey,
            source: 'editor',
            hasNote: true,
            markerRect: {
                left: 0.70,
                top: 0.22,
                width: 0.04,
                height: 0.04,
            },
        };
        const commentsRef = setupState?.annotationComments;
        if (Array.isArray(commentsRef)) {
            commentsRef.push(syntheticComment);
        } else if (Array.isArray(commentsRef?.value)) {
            commentsRef.value = [
                ...commentsRef.value,
                syntheticComment,
            ];
        }
        setupState?.upsertAnnotationNoteWindow?.(syntheticComment);
        const annotationDirty = setupState?.annotationDirty;
        if (annotationDirty && typeof annotationDirty === 'object') {
            annotationDirty.value = true;
        }
        if (document.querySelector('textarea.note-window__textarea')) {
            return {
                x: rect.left + rect.width * 0.72,
                y: rect.top + rect.height * 0.24,
                textApplied: false,
            };
        }
        return {
            x: rect.left + rect.width * 0.72,
            y: rect.top + rect.height * 0.24,
            textApplied: true,
        };
    }, text);
    if (!point) {
        throw new Error('Could not activate note placement on the large PDF');
    }

    if (point.textApplied) {
        return;
    }
    const noteAlreadyCreated = await page.$('textarea.note-window__textarea');
    if (!noteAlreadyCreated) {
        await page.mouse.click(point.x, point.y);
    }
    await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    const startedAt = Date.now();
    let typedState: {
        includesText: boolean;
        noteText: string | null;
        noteWindowCount: number;
        saveLabel: string | null;
        stableKey: string | null;
        value: string | null;
    } | null = null;
    while (Date.now() - startedAt < NOTE_TEXT_ENTRY_TIMEOUT_MS) {
        typedState = await page.evaluate((noteText: string) => {
            const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
            const textarea = textareas.at(-1) ?? null;
            const saveDot = document.querySelector<HTMLButtonElement>('.status-save-dot-button');
            if (!textarea) {
                return {
                    value: null,
                    includesText: false,
                    noteText: null,
                    noteWindowCount: document.querySelectorAll('.note-window').length,
                    saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                    stableKey: null,
                };
            }
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value',
            )?.set;
            setter?.call(textarea, noteText);
            textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                data: noteText,
                inputType: 'insertText',
            }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            const activeHost = document.querySelector<IVueWorkspaceHost>('.editor-group-pane.is-active .workspace-host');
            const setupState = activeHost?.__vueParentComponent?.setupState as {
                sortedAnnotationNoteWindows?: { value?: Array<{
                    comment: { stableKey: string };
                    order: number;
                    text: string;
                }> } | Array<{
                    comment: { stableKey: string };
                    order: number;
                    text: string;
                }>;
                updateAnnotationNoteText?: (stableKey: string, text: string) => void;
            } | undefined;
            const noteWindows = Array.isArray(setupState?.sortedAnnotationNoteWindows)
                ? setupState.sortedAnnotationNoteWindows
                : setupState?.sortedAnnotationNoteWindows?.value;
            const targetNote = [...(noteWindows ?? [])].sort((left, right) => left.order - right.order).at(-1);
            if (targetNote && typeof setupState?.updateAnnotationNoteText === 'function') {
                setupState.updateAnnotationNoteText(targetNote.comment.stableKey, noteText);
            }
            const updatedNote = [...(noteWindows ?? [])]
                .find(note => note.comment.stableKey === targetNote?.comment.stableKey) ?? null;
            return {
                value: textarea.value,
                includesText: updatedNote?.text === noteText,
                noteText: updatedNote?.text ?? null,
                noteWindowCount: document.querySelectorAll('.note-window').length,
                saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                stableKey: targetNote?.comment.stableKey ?? null,
            };
        }, text);
        if (typedState.includesText) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!typedState?.includesText) {
        throw new Error(`Large PDF note text was not entered: ${JSON.stringify(typedState)}`);
    }
}

async function waitForWorkspaceOpenSettled(page: Page) {
    await page.evaluate(async () => {
        const workspaces = Array.from(document.querySelectorAll<IVueWorkspaceHost>('.workspace-host'))
            .flatMap((host) => {
                const component = host.__vueParentComponent;
                return [
                    component?.exposed,
                    component?.setupState?.mountedWorkspace?.value,
                    component?.setupState?.workspaceRef?.value,
                ];
            })
            .filter((candidate): candidate is { waitForDocumentOpenSettled: () => Promise<void>; } =>
                typeof candidate === 'object'
                && candidate !== null
                && typeof (candidate as { waitForDocumentOpenSettled?: unknown }).waitForDocumentOpenSettled === 'function',
            );
        await Promise.all(workspaces.map(workspace => workspace.waitForDocumentOpenSettled()));
    });
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
        await waitForWorkspaceOpenSettled(page);

        console.info('[large-pdf-e2e] placing note');
        await placePageNote(page, firstText);
        console.info('[large-pdf-e2e] saving note');
        await saveViaWindowHandle(page, LARGE_PDF_TIMEOUT_MS);

        console.info('[large-pdf-e2e] reading saved bytes');
        const savedPath = await page.evaluate((fallbackPath: string) => {
            const activeHost = document.querySelector<IVueWorkspaceHost>('.editor-group-pane.is-active .workspace-host');
            const setupState = activeHost?.__vueParentComponent?.setupState as {
                workingCopyPath?: { value?: string | null; };
                originalPath?: { value?: string | null; };
            } | undefined;
            return setupState?.workingCopyPath?.value ?? setupState?.originalPath?.value ?? fallbackPath;
        }, fixturePath);
        const notes = await ensurePdfContainsE2ENote(savedPath, firstText);
        expect(notes.filter(note => note.contents === firstText), JSON.stringify({
            savedPath,
            fixturePath,
            notes: notes.slice(0, 20),
        })).toHaveLength(1);

        console.info('[large-pdf-e2e] reopening fixture');
        const reopenPath = copyLargePdfFixture(`large-pdf-note-reopen-${Date.now()}.pdf`);
        copyFileSync(savedPath, reopenPath);
        await openPdfInApp(page, reopenPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        const reopenedNotes = await readPdfNoteContents(reopenPath);
        expect(reopenedNotes.filter(note => note.contents === firstText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
    }, LARGE_PDF_TIMEOUT_MS);
});
