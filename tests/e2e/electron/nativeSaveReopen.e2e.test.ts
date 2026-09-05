import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import {
    createMultiPageTextFixturePdf,
    createOutlinePageLabelFixturePdf,
    readPdfMetadataWithQpdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {createFreeTextAnnotationWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    saveViaWindowHandle,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    getLatestAutomationEventId,
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

interface IQpdfOutline {
    title?: string;
    destpageposfrom1?: number;
    kids?: IQpdfOutline[];
}

interface IAutomationFileOpenGrantWindow extends IE2EWindow {__allowRendererFileOpenForAutomation?: (value: string) => Promise<boolean>;}

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
    // Startup events can predate the CDP attachment after a fresh-process
    // reopen. Verify the exact active source and rendered UI instead.
    await waitForActiveDocumentSource(session.page, path, 45_000);
    await waitForPdfLoaded(session.page, 45_000);
    await waitForViewerInteractive(session.page, 45_000);
}

async function readOrdinaryFreeTextSnapshot(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const editors = Array.from(document.querySelectorAll<HTMLElement>(
            '.freeTextEditor:not(.pdf-comment-marker-anchor-editor)',
        ));
        const annotationVisuals = Array.from(document.querySelectorAll<HTMLElement>(
            '.annotationLayer .freeTextAnnotation, .annotation-layer .freeTextAnnotation',
        ));
        return {
            editorCount: editors.length,
            visualCount: annotationVisuals.length,
            texts: [
                ...editors,
                ...annotationVisuals,
            ].map(editor => editor.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() ?? ''),
        };
    });
}

describe('Electron E2E - native save and reopen', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('forces a renderer annotation save, on-disk receipt, and fresh-process reopen', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`native-save-reopen-${Date.now()}.pdf`, 2);
        const annotationText = `native save reopen ${Date.now()}`;

        session = await startElectronE2ESession(`e2e-native-save-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await openAnnotationsTab(session.page, 30_000);
        expect(await createFreeTextAnnotationWithPointer(session.page, annotationText, {
            x: 0.44,
            y: 0.38,
        })).toBeGreaterThan(0);
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {hasLivePdfJsAnnotationChanges?: boolean;}}>(
                session!.page,
                ['dirtyState'],
            )
        ).dirtyState?.hasLivePdfJsAnnotationChanges ?? false, {timeout: 20_000}).toBe(true);

        const saveBaselineEventId = await getLatestAutomationEventId(session.page);
        await saveViaWindowHandle(session.page, 60_000);
        await waitForAutomationEvent(session.page, 'save-committed', {
            afterEventId: saveBaselineEventId,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {
                fileDirty?: boolean;
                hasLivePdfJsAnnotationChanges?: boolean;
                hasPendingUnsavedChanges?: boolean;
            };}>(session!.page, ['dirtyState'])
        ).dirtyState, {timeout: 20_000}).toMatchObject({
            fileDirty: false,
            hasLivePdfJsAnnotationChanges: false,
            hasPendingUnsavedChanges: false,
        });
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-native-save-reopen-fresh-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);
        await expect.poll(
            () => readOrdinaryFreeTextSnapshot(session!),
            {timeout: 20_000},
        ).toEqual({
            editorCount: 0,
            visualCount: 1,
            texts: [annotationText],
        });
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
                run: async (page: Parameters<typeof evaluateInPage>[0], path: TDocumentRef) => {
                    return evaluateInPage(page, async ({workingCopyPath}: {workingCopyPath: TDocumentRef}) => {
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
                run: async (page: Parameters<typeof evaluateInPage>[0], path: TDocumentRef) => {
                    return evaluateInPage(page, async ({workingCopyPath}: {workingCopyPath: TDocumentRef}) => {
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
                run: async (page: Parameters<typeof evaluateInPage>[0], path: TDocumentRef) => {
                    return evaluateInPage(page, async ({workingCopyPath}: {workingCopyPath: TDocumentRef}) => {
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
                run: async (page: Parameters<typeof evaluateInPage>[0], path: TDocumentRef) => {
                    return evaluateInPage(page, async ({workingCopyPath}: {workingCopyPath: TDocumentRef}) => {
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
                run: async (page: Parameters<typeof evaluateInPage>[0], path: TDocumentRef) => {
                    return evaluateInPage(page, async ({workingCopyPath}: {workingCopyPath: TDocumentRef}) => {
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
                run: async (page: Parameters<typeof evaluateInPage>[0], path: TDocumentRef, sourcePath?: TDocumentRef) => {
                    if (!sourcePath) throw new Error('Insert fixture source is unavailable');
                    const requestId = requireRequestId('outline-matrix-insert');
                    return evaluateInPage(page, async ({
                        workingCopyPath,
                        sourcePath: source,
                        requestId: insertRequestId,
                    }: {
                        workingCopyPath: TDocumentRef;
                        sourcePath: TDocumentRef;
                        requestId: TRequestId;
                    }) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.insertFile(workingCopyPath, 4, 2, [source], insertRequestId, {expectedDocumentRevisionToken: revision?.token});
                    }, {
                        workingCopyPath: path,
                        sourcePath,
                        requestId,
                    });
                },
            },
        ] as const;

        for (const testCase of cases) {
            const pdfPath = requireDocumentRef(await createOutlinePageLabelFixturePdf(`outline-matrix-${testCase.name}-${Date.now()}.pdf`));
            const sourcePath = testCase.name === 'insert'
                ? requireDocumentRef(await createMultiPageTextFixturePdf(`outline-matrix-${testCase.name}-source-${Date.now()}.pdf`, 1))
                : undefined;
            session = await startElectronE2ESession(`e2e-outline-matrix-${testCase.name}-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session, pdfPath);

            if (sourcePath) {
                const granted = await evaluateInPage(session.page, async path => {
                    const grant = (window as typeof globalThis & IAutomationFileOpenGrantWindow)
                        .__allowRendererFileOpenForAutomation;
                    return typeof grant === 'function' && grant(path);
                }, sourcePath);
                expect(granted, 'insert source path automation grant').toBe(true);
            }

            const workingCopyPath = await evaluateInPage(session.page, async (path: TDocumentRef) => {
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
