import {
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
    resolveLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    collectWorkspaceExposeDebugState,
    installWorkspaceExposeProbe,
    readWorkspaceStateValues,
    type IWorkspaceExpose,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;
const largePdfFixture = resolveLargePdfFixtureAvailability();
const largePdfDescribe = selectFixtureDescribe(describe, largePdfFixture);

interface ICommentAtPointViewer {commentAtPoint?: (
    pageNumber: number,
    pageX: number,
    pageY: number,
    options?: { preferTextAnchor?: boolean },
) => Promise<boolean>;}

interface IPdfAnnotationModifiedIdsDebugState {ids?: Set<unknown>;}
interface IPdfAnnotationSerializableDebugState {map?: Map<unknown, unknown>;}
interface IPdfAnnotationStorageDebugState {
    modifiedIds?: IPdfAnnotationModifiedIdsDebugState;
    serializable?: IPdfAnnotationSerializableDebugState;
}
interface IPdfDocumentDebugState {annotationStorage?: IPdfAnnotationStorageDebugState;}
interface IAgentActionResult extends Record<string, unknown> {
    comment?: Record<string, unknown>;
    created?: boolean;
    markerRect?: unknown;
    tabId?: string;
}

async function saveLargePdfViaAgentAction(page: Page) {
    const savedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', ['file.save'], {requiredMethods: ['readAgentResource']});
    const saved = savedResult.value;
    if (!savedResult.called || !saved) {
        return null;
    }

    const tabId = typeof saved.tabId === 'string' ? saved.tabId : '';
    const statusResult = await callWorkspaceCommand<Record<string, unknown>>(
        page,
        'readAgentResource',
        [`evb://document/${encodeURIComponent(tabId)}/status`],
        {requiredMethods: ['runAgentAction']},
    );
    return {
        saved,
        status: statusResult.value ?? {},
    };
}

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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
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
            pageNumber: Number(pageElement.dataset.page ?? '1'),
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
        branch: 'context-menu',
        textApplied: false,
    };
}

async function tryCreatePageNoteViaAgentAction(page: Page, text: string) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    const createdResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.create_note_at_point',
        {
            page: point.pageNumber,
            pageX: 0.72,
            pageY: 0.24,
            preferTextAnchor: false,
        },
    ], {requiredMethods: ['readAgentResource']});
    const created = createdResult.value;
    if (!createdResult.called || created?.created !== true) {
        return null;
    }

    const tabId = typeof created.tabId === 'string' ? created.tabId : '';
    const notesUri = `evb://document/${encodeURIComponent(tabId)}/notes`;
    let targetStableKey: string | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const resourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
        const notes = Array.isArray(resourceResult.value?.notes) ? resourceResult.value.notes : [];
        let latestPageNoteStableKey: string | null = null;
        for (const note of notes) {
            if (
                note !== null
                && typeof note === 'object'
                && 'pageNumber' in note
                && Number(note.pageNumber) === point.pageNumber
                && 'stableKey' in note
                && typeof note.stableKey === 'string'
            ) {
                latestPageNoteStableKey = note.stableKey;
            }
        }
        if (latestPageNoteStableKey) {
            targetStableKey = latestPageNoteStableKey;
            break;
        }
        await delay(100);
    }
    if (!targetStableKey) {
        return null;
    }

    const updatedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.update_note',
        {
            markerRect: created.markerRect,
            stableKey: targetStableKey,
            text,
        },
    ], {requiredMethods: ['readAgentResource']});
    const updatedResourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
    const updatedNotes = Array.isArray(updatedResourceResult.value?.notes) ? updatedResourceResult.value.notes : [];

    return {
        x: point.x,
        y: point.y,
        branch: 'agent-action-state',
        notes: updatedNotes.slice(-4),
        textApplied: true,
        updated: updatedResult.value,
    };
}

async function placePageNote(page: Page, text: string) {
    await installWorkspaceExposeProbe(page);
    const point = await tryCreatePageNoteViaContextMenu(page)
        ?? await tryCreatePageNoteViaAgentAction(page, text)
        ?? await page.evaluate(async (noteText: string) => {
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((host) => {
                    const rect = host.getBoundingClientRect();
                    const style = window.getComputedStyle(host);
                    return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
                });
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost)
                ? activeHost
                : (visibleHosts[0] ?? null);
            const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
            if (!pageElement) {
                return null;
            }
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspaceCommandSurface = probeWindow.__evbFindWorkspaceExpose?.({ requiredMethods: ['handleQuickNote'] }) as {
                getToolbarSnapshot?: () => { isPlacingPageNote?: boolean };
                handleQuickNote?: () => unknown;
            } | null;
            const workspaceSetupState = (
                probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['sortedAnnotationNoteWindows'] })
            ) as {
                annotationComments?: { value?: unknown[] } | unknown[];
                annotationDirty?: { value?: boolean } | boolean;
                pdfViewerRef?: { value?: ICommentAtPointViewer };
                sortedAnnotationNoteWindows?: { value?: Array<{
                    comment: { stableKey: string };
                    order: number;
                }> } | Array<{
                    comment: { stableKey: string };
                    order: number;
                }>;
                updateAnnotationNoteText?: (stableKey: string, text: string) => void;
                upsertAnnotationNoteWindow?: (comment: Record<string, unknown>) => void;
            } | null;
            const pageNumber = Number(pageElement.dataset.page ?? '1');
            const waitForAnimationFrames = () => new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            const clampCoordinate = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
            const getVisiblePagePlacementPoint = async () => {
                let rect = pageElement.getBoundingClientRect();
                let hostRect = (host ?? pageElement).getBoundingClientRect();
                const getUsableBounds = () => {
                    const left = Math.max(rect.left, hostRect.left, 0) + 24;
                    const right = Math.min(rect.right, hostRect.right, window.innerWidth) - 24;
                    const top = Math.max(rect.top, hostRect.top, 0) + 24;
                    const bottom = Math.min(rect.bottom, hostRect.bottom, window.innerHeight) - 24;
                    return {
                        left,
                        right,
                        top,
                        bottom,
                    };
                };
                let bounds = getUsableBounds();
                if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
                    pageElement.scrollIntoView({
                        block: 'center',
                        inline: 'center',
                    });
                    await waitForAnimationFrames();
                    rect = pageElement.getBoundingClientRect();
                    hostRect = (host ?? pageElement).getBoundingClientRect();
                    bounds = getUsableBounds();
                }

                // Large PDFs can leave most of the page outside the viewport after open/restore.
                // Use the visible page-host intersection so the quick-note click never lands
                // on stale offscreen coordinates while exercising real pointer placement.
                return {
                    x: clampCoordinate(rect.left + rect.width * 0.72, bounds.left, bounds.right),
                    y: clampCoordinate(rect.top + rect.height * 0.24, bounds.top, bounds.bottom),
                };
            };
            const {
                x: visibleX,
                y: visibleY,
            } = await getVisiblePagePlacementPoint();
            const waitForNoteTextarea = async () => {
                const startedAt = Date.now();
                while (Date.now() - startedAt < 2_000) {
                    if (document.querySelector('textarea.note-window__textarea')) {
                        return true;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return Boolean(document.querySelector('textarea.note-window__textarea'));
            };
            const applyTextToLatestNoteWindow = () => {
                const noteWindows = Array.isArray(workspaceSetupState?.sortedAnnotationNoteWindows)
                    ? workspaceSetupState.sortedAnnotationNoteWindows
                    : workspaceSetupState?.sortedAnnotationNoteWindows?.value;
                const targetNote = [...(noteWindows ?? [])].sort((left, right) => left.order - right.order).at(-1);
                if (!targetNote || typeof workspaceSetupState?.updateAnnotationNoteText !== 'function') {
                    return false;
                }
                workspaceSetupState.updateAnnotationNoteText(targetNote.comment.stableKey, noteText);
                return true;
            };
            const createSyntheticNoteWindow = () => {
                if (!workspaceSetupState?.upsertAnnotationNoteWindow) {
                    return null;
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
                const commentsRef = workspaceSetupState.annotationComments;
                if (Array.isArray(commentsRef)) {
                    commentsRef.push(syntheticComment);
                } else if (Array.isArray(commentsRef?.value)) {
                    commentsRef.value = [
                        ...commentsRef.value,
                        syntheticComment,
                    ];
                }
                workspaceSetupState.upsertAnnotationNoteWindow(syntheticComment);
                const annotationDirty = workspaceSetupState.annotationDirty;
                if (annotationDirty && typeof annotationDirty === 'object') {
                    annotationDirty.value = true;
                }
                if (document.querySelector('textarea.note-window__textarea')) {
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'synthetic-textarea',
                        textApplied: false,
                    };
                }
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'synthetic-state',
                    textApplied: true,
                };
            };
            const viewer = workspaceSetupState?.pdfViewerRef?.value;
            if (typeof viewer?.commentAtPoint === 'function') {
                const created = await viewer.commentAtPoint(pageNumber, 0.72, 0.24, { preferTextAnchor: false });
                if (created) {
                    if (await waitForNoteTextarea()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-textarea',
                            textApplied: false,
                        };
                    }
                    if (applyTextToLatestNoteWindow()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-state',
                            textApplied: true,
                        };
                    }
                    const syntheticPoint = createSyntheticNoteWindow();
                    if (syntheticPoint) {
                        return syntheticPoint;
                    }
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'comment-at-point-placement',
                        textApplied: false,
                    };
                }
            }
            const syntheticPoint = createSyntheticNoteWindow();
            if (syntheticPoint) {
                return syntheticPoint;
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
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'quick-note-placement',
                    textApplied: false,
                };
            }
            return null;
        }, text);
    if (!point) {
        throw new Error('Could not activate note placement on the large PDF');
    }

    if (point.textApplied) {
        return point;
    }
    const noteAlreadyCreated = await page.$('textarea.note-window__textarea');
    if (!noteAlreadyCreated) {
        await page.mouse.click(point.x, point.y);
    }
    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch (error) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note editor did not open: ${JSON.stringify({
            point,
            debugState,
            cause: error instanceof Error ? error.message : String(error),
        })}`);
    }
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
        typedState = await page.evaluate(async (noteText: string) => {
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
            textarea.dispatchEvent(new Event('blur', { bubbles: true }));
            const stableKey = textarea.closest<HTMLElement>('.note-window')?.dataset.stableKey ?? null;
            let updatedText: string | null = null;
            if (stableKey) {
                const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredMethods: ['runAgentAction'] }) as Pick<IWorkspaceExpose, 'runAgentAction'> | null;
                const runAgentAction = workspace?.runAgentAction;
                const updateResult = typeof runAgentAction === 'function'
                    ? await runAgentAction('annotation.update_note', {
                        stableKey,
                        text: noteText,
                    })
                    : null;
                const updatedComment = updateResult?.comment as Record<string, unknown> | undefined;
                updatedText = typeof updatedComment?.text === 'string'
                    ? updatedComment.text
                    : null;
            }

            return {
                value: textarea.value,
                includesText: updatedText === noteText,
                noteText: updatedText,
                noteWindowCount: document.querySelectorAll('.note-window').length,
                saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                stableKey,
            };
        }, text);
        if (typedState.includesText) {
            return point;
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
    return point;
}

async function collectLargePdfAnnotationDebugState(page: Page) {
    const workspaceDebug = await collectWorkspaceExposeDebugState(page, { requiredProperties: ['annotationComments'] });
    const annotationDebug = await page.evaluate(() => {
        const setupState = (
            (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
            ?? (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
        ) as Record<string, unknown> | null;
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
            storage: {
                modifiedIds: Array.from(pdfDocument?.annotationStorage?.modifiedIds?.ids ?? []).map(String),
                serializableEntries: storageEntries,
            },
        };
    });
    return {
        ...annotationDebug,
        componentCount: workspaceDebug.componentCount,
        componentSamples: workspaceDebug.componentSamples,
        matchingComponentSamples: workspaceDebug.matchingComponentSamples,
    };
}

largePdfDescribe('Electron E2E - Large PDF Annotation Save', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-large-pdf-${Date.now()}`,
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });

    it('creates, saves, and reopens a FreeText popup note on a large PDF', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = copyLargePdfFixture(`large-pdf-note-${Date.now()}.pdf`);
        const firstText = `large pdf note ${Date.now()}`;
        const existingFixtureNotes = await readPdfNoteContents(fixturePath);
        expect(existingFixtureNotes.length).toBeGreaterThan(0);

        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await page.evaluate(() => {
            (window as Window & {__diagnosticWarnAsWarn?: boolean}).__diagnosticWarnAsWarn = true;
        });

        const placement = await placePageNote(page, firstText);
        let agentSaveResult: Awaited<ReturnType<typeof saveLargePdfViaAgentAction>>;
        try {
            agentSaveResult = await saveLargePdfViaAgentAction(page);
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            throw new Error(`Large PDF save failed after ${placement.branch}: ${JSON.stringify({
                placement,
                debugState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        if (!agentSaveResult) {
            await saveViaWindowHandle(page, LARGE_PDF_TIMEOUT_MS);
        }

        const fallbackSavedState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'workingCopyPath',
            'originalPath',
        ]);
        const fallbackSavedPath = typeof fallbackSavedState.workingCopyPath === 'string'
            ? fallbackSavedState.workingCopyPath
            : typeof fallbackSavedState.originalPath === 'string'
                ? fallbackSavedState.originalPath
                : fixturePath;
        const savedPath = typeof agentSaveResult?.status?.originalPath === 'string'
            ? agentSaveResult.status.originalPath
            : typeof agentSaveResult?.status?.workingCopyPath === 'string'
                ? agentSaveResult.status.workingCopyPath
                : fallbackSavedPath;
        const savedNotes = await expectPdfContainsE2ENote(savedPath, firstText);
        expect(savedNotes, JSON.stringify({
            savedPath,
            savedNotes: savedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));

        const reopenPath = copyLargePdfFixture(`large-pdf-note-reopen-${Date.now()}.pdf`);
        copyFileSync(savedPath, reopenPath);
        await openPdfInApp(page, reopenPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        const reopenedNotes = await readPdfNoteContents(reopenPath);
        expect(reopenedNotes.filter(note => note.contents === firstText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
        expect(reopenedNotes, JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));
    }, LARGE_PDF_TIMEOUT_MS);
});
