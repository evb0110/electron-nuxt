import type { Page } from 'puppeteer-core';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {
    evaluateInPage,
    installPageEvaluationShims,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { createFreeTextAnnotation } from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    getWorkspaceToolbarSnapshot,
    callWorkspaceCommand,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { getActiveWorkspaceWorkingCopyPath } from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    viewerDefaultTimeouts,
    type IViewerDriver,
    type IViewerOperationOutcome,
} from '@scripts/windows-test/guest/viewer/viewerDriver';

const SAVE_POLL_INTERVAL_MS = 250;

function describeError(error: unknown) {
    if (error instanceof Error) {
        return error.stack ?? error.message;
    }
    return typeof error === 'string' ? error : JSON.stringify(error);
}

function failureOutcome(error: unknown): IViewerOperationOutcome {
    return {
        success: false,
        errorCode: describeError(error).slice(0, 240),
        pageCount: null,
    };
}

async function readDocumentRevisionToken(page: Page) {
    const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(page);
    return evaluateInPage(page, async (workingPath) => {
        const getDocumentRevision = (window as IE2EWindow).electronAPI?.documentFiles?.getDocumentRevision;
        if (!getDocumentRevision) {
            throw new Error('electronAPI.documentFiles.getDocumentRevision is unavailable');
        }
        return (await getDocumentRevision(workingPath)).token;
    }, workingCopyPath);
}

async function readTotalPages(page: Page) {
    const snapshot = await getWorkspaceToolbarSnapshot(page);
    if (snapshot === null) {
        throw new Error('the workspace toolbar snapshot is unavailable');
    }
    return snapshot.totalPages;
}

async function deletePageWithToken(
    page: Page,
    pageNumber: number,
    revisionToken: string | null,
): Promise<IViewerOperationOutcome> {
    try {
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(page);
        const pageTotal = await readTotalPages(page);
        const result = await evaluateInPage(page, async ({
            workingPath,
            targetPage,
            expectedTotalPages,
            expectedRevisionToken,
        }: {
            workingPath: string;
            targetPage: number;
            expectedTotalPages: number;
            expectedRevisionToken: TDocumentRevisionToken | null;
        }) => {
            const api = (window as IE2EWindow).electronAPI;
            const deletePages = api?.pageOps?.delete;
            const getDocumentRevision = api?.documentFiles?.getDocumentRevision;
            if (!deletePages || !getDocumentRevision) {
                throw new Error('electronAPI page deletion capability is unavailable');
            }
            const token = expectedRevisionToken ?? (await getDocumentRevision(workingPath)).token;
            const outcome = await deletePages(
                workingPath,
                [targetPage],
                expectedTotalPages,
                { expectedDocumentRevisionToken: token },
            );
            return {
                success: outcome.success,
                pageCount: outcome.pageCount ?? null,
            };
        }, {
            workingPath: workingCopyPath,
            targetPage: pageNumber,
            expectedTotalPages: pageTotal,
            expectedRevisionToken: revisionToken === null ? null : requireDocumentRevisionToken(revisionToken),
        });
        return {
            success: result.success,
            errorCode: result.success ? null : 'page-ops-delete-rejected',
            pageCount: result.pageCount,
        };
    } catch (error) {
        return failureOutcome(error);
    }
}

async function runWorkspaceCommand(page: Page, commandName: string) {
    const result = await callWorkspaceCommand(page, commandName);
    if (!result.called) {
        throw new Error(`the active workspace does not expose ${commandName}`);
    }
}

async function waitUntilSaveSettled(page: Page, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const snapshot = await getWorkspaceToolbarSnapshot(page);
        if (snapshot !== null && !snapshot.isAnySaving) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error('the workspace kept reporting an in-flight save after the deadline');
        }
        await new Promise<void>((resolve) => {
            setTimeout(resolve, SAVE_POLL_INTERVAL_MS);
        });
    }
}

export function createPuppeteerViewerDriver(page: Page): IViewerDriver {
    const rendererFailures: string[] = [];
    page.on('pageerror', (error: unknown) => {
        rendererFailures.push(`[pageerror] ${describeError(error)}`);
    });
    page.on('console', (message) => {
        if (message.type() === 'error') {
            rendererFailures.push(`[console.error] ${message.text()}`);
        }
    });

    const totalPages = async () => {
        const snapshot = await getWorkspaceToolbarSnapshot(page);
        if (snapshot === null) {
            throw new Error('the workspace toolbar snapshot is unavailable');
        }
        return snapshot.totalPages;
    };

    return {
        openDocument: async (filePath) => {
            await installPageEvaluationShims(page);
            await openPdfInApp(page, filePath, viewerDefaultTimeouts.startupMs);
        },
        waitUntilReady: async () => {
            await waitForPdfLoaded(page, viewerDefaultTimeouts.startupMs);
            await waitForViewerInteractive(page, viewerDefaultTimeouts.startupMs);
        },
        workingCopyPath: () => getActiveWorkspaceWorkingCopyPath(page),
        totalPages,
        deletePage: pageNumber => deletePageWithToken(page, pageNumber, null),
        deletePageUsingRevisionToken: (pageNumber, revisionToken) => deletePageWithToken(page, pageNumber, revisionToken),
        documentRevisionToken: () => readDocumentRevisionToken(page),
        save: async () => {
            try {
                await saveViaWindowHandle(page, viewerDefaultTimeouts.operationMs);
                await waitUntilSaveSettled(page, viewerDefaultTimeouts.operationMs);
                return {
                    success: true,
                    errorCode: null,
                    pageCount: await totalPages(),
                };
            } catch (error) {
                return failureOutcome(error);
            }
        },
        requestSaveAsCommand: () => runWorkspaceCommand(page, 'handleSaveAs'),
        printDocumentCommand: () => runWorkspaceCommand(page, 'handlePrint'),
        isPreparingPrint: async () => {
            const snapshot = await getWorkspaceToolbarSnapshot(page);
            return snapshot?.isPreparingPrint === true;
        },
        requestSaveAs: async () => {
            await page.keyboard.down('Control');
            await page.keyboard.down('Shift');
            await page.keyboard.press('KeyS');
            await page.keyboard.up('Shift');
            await page.keyboard.up('Control');
        },
        requestPrint: async () => {
            await page.keyboard.down('Control');
            await page.keyboard.press('KeyP');
            await page.keyboard.up('Control');
        },
        createAnnotation: async (text) => {
            await openAnnotationsTab(page, viewerDefaultTimeouts.operationMs);
            const editorCount = await createFreeTextAnnotation(page, text);
            await page.keyboard.press('Escape');
            return editorCount;
        },
        countTextMatches: async (filePath, query) => {
            const matchCount = await evaluateInPage(page, async ({
                pdfPath,
                searchQuery,
            }) => {
                const run = (window as IE2EWindow).electronAPI?.search?.run;
                if (!run) {
                    throw new Error('electronAPI.search.run is unavailable');
                }
                const response = await run(pdfPath, searchQuery);
                return response.results.length;
            }, {
                pdfPath: filePath,
                searchQuery: query,
            });
            return matchCount;
        },
        pressKeys: async (keys) => {
            for (const key of keys) {
                await page.keyboard.press(key);
            }
        },
        captureScreenshot: async (filePath) => {
            await page.screenshot({ path: filePath });
        },
        rendererFailures: () => [...rendererFailures],
    };
}
