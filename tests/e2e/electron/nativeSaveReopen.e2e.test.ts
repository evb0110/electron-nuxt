import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
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
