import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {stat} from 'node:fs/promises';
import {
    createCanonicalAnnotationSurfaceFixturePdf,
    createMultiPageTextFixturePdf,
    createOutlinePageLabelFixturePdf,
    readPdfMetadataWithQpdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    openAnnotationsTab,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';

const NATIVE_SAVE_REOPEN_TIMEOUT_MS = 120_000;
const OUTLINE_METADATA_MATRIX_TIMEOUT_MS = 15 * 60_000;

interface IAgentActionResult extends Record<string, unknown> {
    comment?: Record<string, unknown>;
    markerRect?: unknown;
    tabId?: string;
    updated?: boolean;
}

interface ICanonicalAnnotationSnapshot {
    comments: Array<Record<string, unknown>>;
    shapes: Array<Record<string, unknown>>;
}

interface IDisplayRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface IQpdfOutline {
    title?: string;
    destpageposfrom1?: number;
    kids?: IQpdfOutline[];
}

function flattenQpdfOutlines(outlines: IQpdfOutline[]): Array<{
    title: string;
    page: number;
    depth: number
}> {
    return outlines.flatMap(outline => [
        ...(typeof outline.title === 'string' && typeof outline.destpageposfrom1 === 'number'
            ? [{
                title: outline.title,
                page: outline.destpageposfrom1,
                depth: 0,
            }]
            : []),
        ...flattenQpdfOutlines(outline.kids ?? []).map(item => ({
            ...item,
            depth: item.depth + 1,
        })),
    ]);
}

async function waitForOpenedPdf(session: IElectronE2ESession, path: string) {
    await Promise.all([
        waitForAutomationEvent(session.page, 'document-opened', {
            path,
            timeoutMs: 45_000,
        }),
        waitForAutomationEvent(session.page, 'first-page-rendered', {
            path,
            timeoutMs: 45_000,
        }),
    ]);
    await waitForPdfLoaded(session.page, 45_000);
    await waitForViewerInteractive(session.page, 45_000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function numberField(record: Record<string, unknown>, name: string) {
    const value = record[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown>, name: string) {
    const value = record[name];
    return typeof value === 'string' ? value : null;
}

function roundGeometry(value: number) {
    return Math.round(value * 10_000) / 10_000;
}

function normalizedRect(value: unknown): IDisplayRect | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }
    const left = numberField(record, 'left');
    const top = numberField(record, 'top');
    const width = numberField(record, 'width');
    const height = numberField(record, 'height');
    return left === null || top === null || width === null || height === null
        ? null
        : {
            left: roundGeometry(left),
            top: roundGeometry(top),
            width: roundGeometry(width),
            height: roundGeometry(height),
        };
}

function normalizedPoints(value: unknown): unknown {
    if (!Array.isArray(value)) {
        return null;
    }
    return value.map((point) => {
        if (Array.isArray(point)) {
            return normalizedPoints(point);
        }
        const record = asRecord(point);
        if (!record) {
            return point;
        }
        const x = numberField(record, 'x');
        const y = numberField(record, 'y');
        return x === null || y === null
            ? point
            : {
                x: roundGeometry(x),
                y: roundGeometry(y),
            };
    });
}

function canonicalAnnotationFingerprint(snapshot: ICanonicalAnnotationSnapshot) {
    const comments = snapshot.comments.map(comment => ({
        pageIndex: numberField(comment, 'pageIndex'),
        text: stringField(comment, 'text'),
        subtype: stringField(comment, 'subtype'),
        color: stringField(comment, 'color'),
        fillColor: stringField(comment, 'fillColor'),
        opacity: numberField(comment, 'opacity') === null
            ? null
            : roundGeometry(numberField(comment, 'opacity')!),
        strokeWidth: numberField(comment, 'strokeWidth') === null
            ? null
            : roundGeometry(numberField(comment, 'strokeWidth')!),
        markerRect: normalizedRect(comment.markerRect),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const shapes = snapshot.shapes.map(shape => ({
        pageIndex: numberField(shape, 'pageIndex'),
        pdfSubtype: stringField(shape, 'pdfSubtype'),
        x: numberField(shape, 'x') === null ? null : roundGeometry(numberField(shape, 'x')!),
        y: numberField(shape, 'y') === null ? null : roundGeometry(numberField(shape, 'y')!),
        width: numberField(shape, 'width') === null ? null : roundGeometry(numberField(shape, 'width')!),
        height: numberField(shape, 'height') === null ? null : roundGeometry(numberField(shape, 'height')!),
        x2: numberField(shape, 'x2') === null ? null : roundGeometry(numberField(shape, 'x2')!),
        y2: numberField(shape, 'y2') === null ? null : roundGeometry(numberField(shape, 'y2')!),
        color: stringField(shape, 'color'),
        fillColor: stringField(shape, 'fillColor'),
        opacity: numberField(shape, 'opacity') === null ? null : roundGeometry(numberField(shape, 'opacity')!),
        strokeWidth: numberField(shape, 'strokeWidth') === null ? null : roundGeometry(numberField(shape, 'strokeWidth')!),
        points: normalizedPoints(shape.points),
        strokes: normalizedPoints(shape.strokes),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify({
        comments,
        shapes,
    });
}

async function readCanonicalAnnotationSnapshot(page: Parameters<typeof evaluateInPage>[0]): Promise<ICanonicalAnnotationSnapshot> {
    return page.evaluate(async (): Promise<ICanonicalAnnotationSnapshot> => {
        const api = (window as IE2EWindow).__evbTestApi;
        const copyValue = (value: unknown): unknown => {
            if (Array.isArray(value)) {
                return value.map(copyValue);
            }
            if (value !== null && typeof value === 'object') {
                return Object.fromEntries(
                    Object.entries(value).map(([
                        key,
                        nestedValue,
                    ]) => [
                        key,
                        copyValue(nestedValue),
                    ]),
                );
            }
            return value;
        };
        const state = api?.readActiveWorkspaceStateValues<{annotationComments?: unknown[]}>(['annotationComments']);
        const shapeResult = await api?.callActiveWorkspaceCommand<unknown[]>('getAllShapes');
        const comments = Array.isArray(state?.annotationComments)
            ? state.annotationComments.flatMap(comment => {
                const copied = copyValue(comment);
                return copied !== null && typeof copied === 'object' && !Array.isArray(copied)
                    ? [copied as Record<string, unknown>]
                    : [];
            })
            : [];
        const shapes = Array.isArray(shapeResult?.value)
            ? shapeResult.value.flatMap(shape => {
                const copied = copyValue(shape);
                return copied !== null && typeof copied === 'object' && !Array.isArray(copied)
                    ? [copied as Record<string, unknown>]
                    : [];
            })
            : [];
        return {
            comments,
            shapes,
        };
    });
}

async function waitForParsedTextBoxComment(page: Parameters<typeof evaluateInPage>[0]) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const snapshot = await readCanonicalAnnotationSnapshot(page);
        const textBox = snapshot.comments.find(comment => (
            stringField(comment, 'subtype') === 'FreeText'
            && typeof comment.stableKey === 'string'
            && normalizedRect(comment.markerRect) !== null
        ));
        if (textBox) {
            return textBox;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The parsed canonical text box was not published');
}

async function readTextBoxDisplayRect(page: Parameters<typeof evaluateInPage>[0]): Promise<IDisplayRect | null> {
    return evaluateInPage(page, () => {
        const pageContainer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"]',
        );
        const textBox = pageContainer?.querySelector<HTMLElement>('[data-annotation-kind="text-box"]');
        if (!pageContainer || !textBox) {
            return null;
        }
        const pageRect = pageContainer.getBoundingClientRect();
        const boxRect = textBox.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return null;
        }
        return {
            left: (boxRect.left - pageRect.left) / pageRect.width,
            top: (boxRect.top - pageRect.top) / pageRect.height,
            width: boxRect.width / pageRect.width,
            height: boxRect.height / pageRect.height,
        };
    });
}

async function waitForTextBoxDisplay(page: Parameters<typeof evaluateInPage>[0]) {
    await page.waitForFunction(() => Boolean(document.querySelector(
        '.editor-pane.is-active .page_container[data-page="1"] [data-annotation-kind="text-box"]',
    )), {timeout: 20_000});
}

describe('Electron E2E - native save and reopen', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('moves a parsed store-owned text box through save and fresh-process reopen', async () => {
        const pdfPath = await createCanonicalAnnotationSurfaceFixturePdf(
            `native-save-reopen-${Date.now()}-canonical-surface.pdf`,
        );

        session = await startElectronE2ESession(`e2e-native-save-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await openAnnotationsTab(session.page, 30_000);
        await waitForTextBoxDisplay(session.page);

        const initialSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const initialFingerprint = canonicalAnnotationFingerprint(initialSnapshot);
        const textBoxComment = await waitForParsedTextBoxComment(session.page);
        const originalRect = normalizedRect(textBoxComment.markerRect);
        const text = stringField(textBoxComment, 'text');
        const stableKey = stringField(textBoxComment, 'stableKey');
        expect(originalRect).not.toBeNull();
        expect(text).not.toBeNull();
        expect(stableKey).not.toBeNull();
        if (!originalRect || !text || !stableKey) {
            throw new Error('The parsed text box did not expose its canonical identity and geometry');
        }
        expect(textBoxComment).toMatchObject({
            source: 'pdf',
            hasNote: true,
        });

        const movedRect = normalizedRect({
            ...originalRect,
            left: originalRect.left + 0.08,
            top: originalRect.top + 0.06,
        });
        if (!movedRect) {
            throw new Error('The moved text box rectangle could not be normalized');
        }
        const updateResult = await callWorkspaceCommand<IAgentActionResult>(session.page, 'runAgentAction', [
            'annotation.update_note',
            {
                markerRect: movedRect,
                stableKey,
                text,
            },
        ]);
        expect(updateResult.called).toBe(true);
        expect(updateResult.value?.updated).toBe(true);

        await expect.poll(async () => {
            const snapshot = await readCanonicalAnnotationSnapshot(session!.page);
            const updatedTextBox = snapshot.comments.find(comment => stringField(comment, 'stableKey') === stableKey);
            return normalizedRect(updatedTextBox?.markerRect);
        }, {timeout: 20_000}).toEqual(movedRect);
        await expect.poll(async () => {
            const rect = await readTextBoxDisplayRect(session!.page);
            return rect !== null
                && Math.abs(rect.left - movedRect.left) < 0.005
                && Math.abs(rect.top - movedRect.top) < 0.005;
        }, {timeout: 20_000}).toBe(true);
        const movedDisplayRect = await readTextBoxDisplayRect(session.page);
        expect(movedDisplayRect).not.toBeNull();
        if (!movedDisplayRect) {
            throw new Error('The moved canonical text box was not rendered');
        }
        expect(movedDisplayRect.left).toBeCloseTo(movedRect.left, 2);
        expect(movedDisplayRect.top).toBeCloseTo(movedRect.top, 2);
        const movedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const movedFingerprint = canonicalAnnotationFingerprint(movedSnapshot);
        expect(movedFingerprint).not.toBe(initialFingerprint);

        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {
                annotationDirty?: boolean;
                fileDirty?: boolean;
                hasPendingUnsavedChanges?: boolean;
            };}>(
                session!.page,
                ['dirtyState'],
            )
        ).dirtyState, {timeout: 20_000}).toMatchObject({
            annotationDirty: true,
            hasPendingUnsavedChanges: true,
        });

        await saveViaWindowHandle(session.page, 60_000);
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {
                annotationDirty?: boolean;
                fileDirty?: boolean;
                hasLivePdfJsAnnotationChanges?: boolean;
                hasPendingUnsavedChanges?: boolean;
            };}>(session!.page, ['dirtyState'])
        ).dirtyState, {timeout: 20_000}).toMatchObject({
            annotationDirty: false,
            fileDirty: false,
            hasLivePdfJsAnnotationChanges: false,
            hasPendingUnsavedChanges: false,
        });
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);

        const savedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        expect(savedSnapshot.comments.length).toBeGreaterThan(0);
        expect(savedSnapshot.comments.every(comment => (
            typeof comment.annotationId === 'string' && comment.annotationId.length > 0
        ))).toBe(true);
        expect(savedSnapshot.shapes.length).toBeGreaterThan(0);
        expect(savedSnapshot.shapes.every(shape => (
            typeof shape.annotationId === 'string' && shape.annotationId.length > 0
        ))).toBe(true);

        const cleanSaveBefore = await stat(pdfPath);
        const cleanSaveResult = await callWorkspaceCommand<boolean>(session.page, 'handleSave');
        expect(cleanSaveResult.called).toBe(true);
        expect(cleanSaveResult.value).toBe(true);
        const cleanSaveAfter = await stat(pdfPath);
        expect(cleanSaveAfter.size).toBe(cleanSaveBefore.size);
        expect(cleanSaveAfter.mtimeMs).toBe(cleanSaveBefore.mtimeMs);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-native-save-reopen-fresh-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await waitForTextBoxDisplay(session.page);
        const reopenedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        expect(canonicalAnnotationFingerprint(reopenedSnapshot)).toBe(movedFingerprint);
        const reopenedDisplayRect = await readTextBoxDisplayRect(session.page);
        expect(reopenedDisplayRect).not.toBeNull();
        if (!reopenedDisplayRect) {
            throw new Error('The canonical text box was not rendered after fresh-process reopen');
        }
        expect(reopenedDisplayRect.left).toBeCloseTo(movedRect.left, 2);
        expect(reopenedDisplayRect.top).toBeCloseTo(movedRect.top, 2);
        expect(reopenedSnapshot.comments.every(comment => (
            typeof comment.annotationId === 'string' && comment.annotationId.length > 0
        ))).toBe(true);
        expect(reopenedSnapshot.shapes.every(shape => (
            typeof shape.annotationId === 'string' && shape.annotationId.length > 0
        ))).toBe(true);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);
    }, NATIVE_SAVE_REOPEN_TIMEOUT_MS);

    it('preserves outlines and page labels through the six-operation fresh-process matrix', async () => {
        const cases = [
            {
                name: 'rotate',
                totalPages: 4,
                expectedPages: [
                    1,
                    3,
                    4,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.rotate(workingCopyPath, [1], 4, 90, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'delete',
                totalPages: 3,
                expectedPages: [
                    1,
                    2,
                    3,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.delete(workingCopyPath, [2], 4, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'reorder',
                totalPages: 4,
                expectedPages: [
                    2,
                    4,
                    1,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.reorder(workingCopyPath, [
                            4,
                            1,
                            2,
                            3,
                        ], {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'crop',
                totalPages: 4,
                expectedPages: [
                    1,
                    3,
                    4,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.crop(workingCopyPath, [1], 4, {
                            top: 5,
                            bottom: 5,
                            left: 5,
                            right: 5,
                        }, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'move',
                totalPages: 4,
                expectedPages: [
                    4,
                    2,
                    3,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.move(workingCopyPath, 1, 1, 4, 4, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'insert',
                totalPages: 5,
                expectedPages: [
                    1,
                    4,
                    5,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string, sourcePath?: string) => {
                    if (!sourcePath) throw new Error('Insert fixture source is unavailable');
                    return evaluateInPage(page, async ({
                        workingCopyPath,
                        sourcePath: source,
                    }) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.insertFile(workingCopyPath, 4, 2, [source], 'outline-matrix-insert', {expectedDocumentRevisionToken: revision?.token});
                    }, {
                        workingCopyPath: path,
                        sourcePath,
                    });
                },
            },
        ] as const;

        for (const testCase of cases) {
            const pdfPath = await createOutlinePageLabelFixturePdf(`outline-matrix-${testCase.name}-${Date.now()}.pdf`);
            const sourcePath = testCase.name === 'insert'
                ? await createMultiPageTextFixturePdf(`outline-matrix-${testCase.name}-source-${Date.now()}.pdf`, 1)
                : undefined;
            session = await startElectronE2ESession(`e2e-outline-matrix-${testCase.name}-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: sourcePath ? [
                    pdfPath,
                    sourcePath,
                ] : [pdfPath],
            });
            await waitForOpenedPdf(session, pdfPath);

            const workingCopyPath = await evaluateInPage(session.page, async path => {
                const api = (window as IE2EWindow).electronAPI;
                if (!api) throw new Error('electronAPI is unavailable');
                return api.documentWorkingCopy.createWorkingCopyFromPath(path, path);
            }, pdfPath);
            const result = await testCase.run(session.page, workingCopyPath, sourcePath);
            expect(result?.success, `${testCase.name} native page operation`).toBe(true);
            const saveResult = await evaluateInPage(session.page, async ({workingCopyPath: path}) => {
                const api = (window as IE2EWindow).electronAPI;
                if (!api) throw new Error('electronAPI is unavailable');
                const revision = await api.documentFiles.getDocumentRevision(path);
                return api.documentFiles.saveFileStructured(path, {expectedDocumentRevisionToken: revision.token});
            }, {workingCopyPath});
            expect(saveResult.ok, `${testCase.name} structured save`).toBe(true);
            const previousSession = session;
            session = null;
            await previousSession.stop();
            session = await startElectronE2ESession(`e2e-outline-matrix-${testCase.name}-fresh-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session, pdfPath);

            const freshSession = session;
            session = null;
            await freshSession.stop();
            const metadata = await readPdfMetadataWithQpdf(pdfPath);
            const flattenedOutlines = flattenQpdfOutlines(metadata.outlines);
            expect(flattenedOutlines.map(outline => outline.title)).toEqual([
                'Parent',
                'Child',
                'Appendix',
            ]);
            expect(flattenedOutlines.map(outline => outline.page)).toEqual(testCase.expectedPages);
            expect(flattenedOutlines.map(outline => outline.depth)).toEqual([
                0,
                1,
                0,
            ]);
            expect(metadata.pagelabels.length).toBeGreaterThanOrEqual(2);
            expect(metadata.pagelabels.map(label => label.label?.['/P'])).toEqual(expect.arrayContaining([
                'u:front-',
                'u:chapter-',
            ]));
        }
    }, OUTLINE_METADATA_MATRIX_TIMEOUT_MS);
});
