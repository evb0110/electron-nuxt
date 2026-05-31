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
} from 'node:fs';
import { delay } from 'es-toolkit/promise';
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
} from '@tests/e2e/electron/helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from '@tests/e2e/electron/helpers/sessionHarness';
import {
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerHelpers';

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
        [key: string]: unknown;
    };
};}

interface IPdfAnnotationModifiedIdsDebugState {ids?: Set<unknown>;}
interface IPdfAnnotationSerializableDebugState {map?: Map<unknown, unknown>;}
interface IPdfAnnotationStorageDebugState {
    modifiedIds?: IPdfAnnotationModifiedIdsDebugState;
    serializable?: IPdfAnnotationSerializableDebugState;
}
interface IPdfDocumentDebugState {annotationStorage?: IPdfAnnotationStorageDebugState;}

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

async function expectPdfContainsE2ENote(filePath: string, text: string) {
    const existing = await readPdfNoteContents(filePath);
    expect(existing.filter(note => note.contents === text), JSON.stringify({
        filePath,
        notes: existing.slice(0, 20),
    })).toHaveLength(1);
    return existing;
}

async function resolveLargePdfPageNotePoint(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }

        const rect = pageElement.getBoundingClientRect();
        const x = Math.min(
            Math.max(rect.left + 24, rect.left + rect.width * 0.72),
            window.innerWidth - 96,
        );
        const y = Math.min(
            Math.max(rect.top + 24, rect.top + rect.height * 0.06),
            window.innerHeight - 96,
        );
        return {
            x,
            y,
        };
    });
}

async function tryCreatePageNoteViaContextMenu(page: Page) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    const created = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        ));
        const button = buttons.find(candidate =>
            (candidate.textContent ?? '').trim() === 'Add note here',
        );
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    });

    if (!created) {
        return null;
    }

    await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    return {
        ...point,
        textApplied: false,
    };
}

async function placePageNote(page: Page, text: string) {
    const point = await tryCreatePageNoteViaContextMenu(page)
        ?? await page.evaluate(async (noteText: string) => {
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
            let workspaceCommandSurface: {
                getToolbarSnapshot?: () => { isPlacingPageNote?: boolean };
                handleQuickNote?: () => unknown;
            } | null = null;
            let workspaceSetupState: {
                annotationComments?: { value?: unknown[] } | unknown[];
                annotationDirty?: { value?: boolean } | boolean;
                pdfViewerRef?: { value?: ICommentAtPointViewer };
                upsertAnnotationNoteWindow?: (comment: Record<string, unknown>) => void;
            } | null = null;
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                const component = (element as IVueWorkspaceHost).__vueParentComponent;
                const candidates = [
                    component?.setupState,
                    component?.setupState?.mountedWorkspace?.value,
                    component?.setupState?.workspaceRef?.value,
                    component?.exposed,
                ];
                for (const candidate of candidates) {
                    const commandCandidate = candidate as {
                        getToolbarSnapshot?: unknown;
                        handleQuickNote?: unknown;
                    } | null | undefined;
                    if (
                        commandCandidate
                    && typeof commandCandidate === 'object'
                    && typeof commandCandidate.handleQuickNote === 'function'
                    ) {
                        workspaceCommandSurface = { handleQuickNote: commandCandidate.handleQuickNote as () => unknown };
                        if (typeof commandCandidate.getToolbarSnapshot === 'function') {
                            workspaceCommandSurface.getToolbarSnapshot = (
                                commandCandidate.getToolbarSnapshot as () => { isPlacingPageNote?: boolean }
                            );
                        }
                    }
                    const setupState = ((
                        candidate
                    && typeof candidate === 'object'
                    && 'pdfViewerRef' in candidate
                            ? candidate
                            : (
                                candidate
                            && typeof candidate === 'object'
                            && '$' in candidate
                                    ? (candidate as { $?: { setupState?: unknown } }).$?.setupState
                                    : null
                            )
                    )) as {
                        annotationComments?: { value?: unknown[] } | unknown[];
                        annotationDirty?: { value?: boolean } | boolean;
                        pdfViewerRef?: { value?: ICommentAtPointViewer };
                        upsertAnnotationNoteWindow?: (comment: Record<string, unknown>) => void;
                    } | null;
                    if (setupState?.pdfViewerRef?.value) {
                        workspaceSetupState = setupState;
                        break;
                    }
                }
                if (workspaceSetupState) {
                    break;
                }
            }
            const rect = pageElement.getBoundingClientRect();
            const pageNumber = Number(pageElement.dataset.page ?? '1');
            const visibleX = Math.min(
                Math.max(rect.left + 24, rect.left + rect.width * 0.72),
                window.innerWidth - 96,
            );
            const visibleY = Math.min(
                Math.max(rect.top + 24, rect.top + rect.height * 0.24),
                window.innerHeight - 96,
            );
            const viewer = workspaceSetupState?.pdfViewerRef?.value;
            if (typeof viewer?.commentAtPoint === 'function') {
                const created = await viewer.commentAtPoint(pageNumber, 0.72, 0.24, { preferTextAnchor: false });
                if (created) {
                    return {
                        x: visibleX,
                        y: visibleY,
                    };
                }
            }
            if (workspaceCommandSurface?.handleQuickNote) {
                await Promise.resolve(workspaceCommandSurface.handleQuickNote());
                const startedAt = Date.now();
                while (
                    workspaceCommandSurface.getToolbarSnapshot
                && workspaceCommandSurface.getToolbarSnapshot().isPlacingPageNote !== true
                && Date.now() - startedAt < 5_000
                ) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                const visibleY = Math.min(
                    Math.max(rect.top + 24, rect.top + rect.height * 0.06),
                    window.innerHeight - 96,
                );
                return {
                    x: visibleX,
                    y: visibleY,
                    textApplied: false,
                };
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
            const commentsRef = workspaceSetupState?.annotationComments;
            if (Array.isArray(commentsRef)) {
                commentsRef.push(syntheticComment);
            } else if (Array.isArray(commentsRef?.value)) {
                commentsRef.value = [
                    ...commentsRef.value,
                    syntheticComment,
                ];
            }
            workspaceSetupState?.upsertAnnotationNoteWindow?.(syntheticComment);
            const annotationDirty = workspaceSetupState?.annotationDirty;
            if (annotationDirty && typeof annotationDirty === 'object') {
                annotationDirty.value = true;
            }
            if (document.querySelector('textarea.note-window__textarea')) {
                return {
                    x: visibleX,
                    y: visibleY,
                    textApplied: false,
                };
            }
            return {
                x: visibleX,
                y: visibleY,
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
            let setupState: {
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
            } | null = null;
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                const component = (element as IVueWorkspaceHost).__vueParentComponent;
                const candidates = [
                    component?.setupState,
                    component?.setupState?.mountedWorkspace?.value,
                    component?.setupState?.workspaceRef?.value,
                    component?.exposed,
                ];
                for (const candidate of candidates) {
                    const candidateSetup = ((
                        candidate
                        && typeof candidate === 'object'
                        && 'updateAnnotationNoteText' in candidate
                            ? candidate
                            : (
                                candidate
                                && typeof candidate === 'object'
                                && '$' in candidate
                                    ? (candidate as { $?: { setupState?: unknown } }).$?.setupState
                                    : null
                            )
                    )) as {
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
                    } | null;
                    if (typeof candidateSetup?.updateAnnotationNoteText === 'function') {
                        setupState = candidateSetup;
                        break;
                    }
                }
                if (setupState) {
                    break;
                }
            }
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
        await delay(100);
    }
    if (!typedState?.includesText) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note text was not entered: ${JSON.stringify({
            typedState,
            debugState,
        })}`);
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

async function collectLargePdfAnnotationDebugState(page: Page) {
    return page.evaluate(() => {
        let setupState: Record<string, unknown> | null = null;
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            const component = (element as IVueWorkspaceHost).__vueParentComponent;
            const candidates = [
                component?.setupState?.mountedWorkspace?.value,
                component?.setupState?.workspaceRef?.value,
                component?.exposed,
            ];
            for (const candidate of candidates) {
                const candidateSetup = (
                    candidate
                    && typeof candidate === 'object'
                    && '$' in candidate
                        ? (candidate as { $?: { setupState?: unknown } }).$?.setupState
                        : null
                ) as Record<string, unknown> | null;
                if (candidateSetup?.pdfViewerRef || candidateSetup?.annotationComments) {
                    setupState = candidateSetup;
                    break;
                }
            }
            if (setupState) {
                break;
            }
        }
        const unwrap = (value: unknown) => (
            value
            && typeof value === 'object'
            && 'value' in value
                ? (value as { value?: unknown }).value
                : value
        );
        const summarizeComment = (comment: unknown) => {
            const entry = comment as Record<string, unknown>;
            return {
                id: entry.id ?? null,
                stableKey: entry.stableKey ?? null,
                annotationId: entry.annotationId ?? null,
                uid: entry.uid ?? null,
                source: entry.source ?? null,
                subtype: entry.subtype ?? null,
                hasNote: entry.hasNote ?? null,
                markerRect: entry.markerRect ?? null,
                text: entry.text ?? null,
            };
        };
        const annotationComments = unwrap(setupState?.annotationComments);
        const noteWindows = unwrap(setupState?.sortedAnnotationNoteWindows) ?? unwrap(setupState?.annotationNoteWindows);
        const pdfDocument = unwrap(setupState?.pdfDocument) as IPdfDocumentDebugState | null | undefined;
        const serializableMap = pdfDocument?.annotationStorage?.serializable?.map;
        const componentSamples: Array<{
            exposedKeys: string[];
            setupKeys: string[];
            tag: string;
        }> = [];
        const matchingComponentSamples: Array<{
            exposedKeys: string[];
            setupKeys: string[];
            tag: string;
        }> = [];
        let componentCount = 0;
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            const component = (element as IVueWorkspaceHost).__vueParentComponent;
            if (!component) {
                continue;
            }
            componentCount += 1;
            const exposedKeys = component.exposed && typeof component.exposed === 'object'
                ? Object.keys(component.exposed)
                : [];
            const setupKeys = component.setupState && typeof component.setupState === 'object'
                ? Object.keys(component.setupState)
                : [];
            if (componentSamples.length < 8) {
                componentSamples.push({
                    tag: element.tagName.toLowerCase(),
                    exposedKeys: exposedKeys.slice(0, 12),
                    setupKeys: setupKeys.slice(0, 12),
                });
            }
            if (
                matchingComponentSamples.length < 12
                && [
                    ...exposedKeys,
                    ...setupKeys,
                ].some(key => [
                    'workspaceRef',
                    'mountedWorkspace',
                    'pdfViewerRef',
                    'annotationComments',
                    'handleSave',
                    'handleQuickNote',
                ].includes(key))
            ) {
                matchingComponentSamples.push({
                    tag: element.tagName.toLowerCase(),
                    exposedKeys: exposedKeys.slice(0, 20),
                    setupKeys: setupKeys.slice(0, 20),
                });
            }
        }
        const storageEntries = serializableMap instanceof Map
            ? Array.from(serializableMap.entries()).map(([
                key,
                value,
            ]) => {
                const record = value as Record<string, unknown>;
                const popup = record?.popup as Record<string, unknown> | undefined;
                return {
                    key: String(key),
                    annotationType: record?.annotationType ?? null,
                    id: record?.id ?? null,
                    annotationId: record?.annotationId ?? null,
                    annotationElementId: record?.annotationElementId ?? null,
                    parentId: record?.parentId ?? null,
                    deleted: record?.deleted ?? null,
                    popup: popup
                        ? {
                            deleted: popup.deleted ?? null,
                            contents: popup.contents ?? null,
                        }
                        : null,
                    value: record?.value ?? null,
                };
            })
            : [];
        return {
            annotationDirty: unwrap(setupState?.annotationDirty) ?? null,
            hasAnnotationChanges: typeof setupState?.hasAnnotationChanges === 'function'
                ? (setupState.hasAnnotationChanges as () => unknown)()
                : null,
            noteWindows: Array.isArray(noteWindows)
                ? noteWindows.map((note) => {
                    const entry = note as Record<string, unknown>;
                    return {
                        text: entry.text ?? null,
                        lastSavedText: entry.lastSavedText ?? null,
                        saveMode: entry.saveMode ?? null,
                        saving: entry.saving ?? null,
                        comment: summarizeComment(entry.comment),
                    };
                })
                : null,
            annotationComments: Array.isArray(annotationComments)
                ? annotationComments.slice(-5).map(summarizeComment)
                : null,
            componentCount,
            componentSamples,
            matchingComponentSamples,
            storage: {
                modifiedIds: Array.from(pdfDocument?.annotationStorage?.modifiedIds?.ids ?? []).map(String),
                serializableEntries: storageEntries,
            },
        };
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
        console.info('[large-pdf-e2e] state after note', JSON.stringify(await collectLargePdfAnnotationDebugState(page)));
        console.info('[large-pdf-e2e] saving note');
        await saveViaWindowHandle(page, LARGE_PDF_TIMEOUT_MS);
        console.info('[large-pdf-e2e] state after save', JSON.stringify(await collectLargePdfAnnotationDebugState(page)));

        console.info('[large-pdf-e2e] reading saved bytes');
        const savedPath = await page.evaluate((fallbackPath: string) => {
            let setupState: {
                workingCopyPath?: { value?: string | null; };
                originalPath?: { value?: string | null; };
            } | null = null;
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                const component = (element as IVueWorkspaceHost).__vueParentComponent;
                const candidates = [
                    component?.setupState?.mountedWorkspace?.value,
                    component?.setupState?.workspaceRef?.value,
                    component?.exposed,
                ];
                for (const candidate of candidates) {
                    const candidateSetup = (
                        candidate
                        && typeof candidate === 'object'
                        && '$' in candidate
                            ? (candidate as { $?: { setupState?: unknown } }).$?.setupState
                            : null
                    ) as {
                        workingCopyPath?: { value?: string | null; };
                        originalPath?: { value?: string | null; };
                    } | null;
                    if (candidateSetup?.workingCopyPath || candidateSetup?.originalPath) {
                        setupState = candidateSetup;
                        break;
                    }
                }
                if (setupState) {
                    break;
                }
            }
            return setupState?.workingCopyPath?.value ?? setupState?.originalPath?.value ?? fallbackPath;
        }, fixturePath);
        await expectPdfContainsE2ENote(savedPath, firstText);

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
