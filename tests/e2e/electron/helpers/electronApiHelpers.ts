import type { Page } from 'puppeteer-core';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { readPdfPageSnapshots } from '@tests/e2e/electron/helpers/fixtures';

function normalizeSemanticText(value: string) {
    return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

export async function assertOcrPdfSemanticOutput(pdfPath: string, expectedText: string) {
    const recognizedText = (await readPdfPageSnapshots(pdfPath))
        .map(page => page.textSnippet)
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
    const normalizedRecognizedText = normalizeSemanticText(recognizedText);
    const normalizedExpectedText = normalizeSemanticText(expectedText);
    if (!normalizedRecognizedText.includes(normalizedExpectedText)) {
        throw new Error(`OCR output did not contain expected semantic text: ${JSON.stringify({
            expectedText,
            pdfPath,
            recognizedText,
        })}`);
    }
    return recognizedText;
}


export async function getActiveWorkspaceWorkingCopyPath(page: Page) {
    const { workingCopyPath } = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(page, ['workingCopyPath']);
    if (typeof workingCopyPath !== 'string' || workingCopyPath.trim().length === 0) {
        throw new Error('workingCopyPath is unavailable on the active workspace');
    }

    return workingCopyPath;
}

export async function runOcrSearchablePdf(
    page: Page,
    sourcePdfPath: string,
    requestId: string,
    expectedText: string,
) {
    const result = await evaluateInPage(page, async ({
        sourcePath,
        id,
    }) => {
        const api = (window as IE2EWindow & {electronAPI?: {ocr?: {
            onProgress?: (callback: (progress: {requestId: string;}) => void) => () => void;
            onComplete?: (callback: (result: {
                requestId: string;
                success: boolean;
                pdfPath?: string;
                sourceDocumentRevisionToken?: string;
                requiresCleanupAck?: boolean;
                errors: string[];
            }) => void) => () => void;
            createSearchablePdf?: (
                sourcePdfPath: string,
                pages: Array<{
                    pageNumber: number;
                    languages: string[];
                }>,
                requestId: string,
                renderDpi?: number,
            ) => Promise<{
                started: boolean;
                error?: string;
            }>;
        };};}).electronAPI;

        const ocr = api?.ocr;
        if (!ocr?.createSearchablePdf || !ocr.onComplete || !ocr.onProgress) {
            throw new Error('electronAPI.ocr is unavailable');
        }

        const progressEvents: Array<{requestId: string;}> = [];
        let disposeProgress = () => {};
        let disposeComplete = () => {};

        try {
            const completion = new Promise<{
                requestId: string;
                success: boolean;
                pdfPath?: string;
                sourceDocumentRevisionToken?: string;
                requiresCleanupAck?: boolean;
                errors: string[];
            }>((resolve, reject) => {
                const timeoutId = window.setTimeout(() => {
                    reject(new Error('Timed out waiting for OCR completion event'));
                }, 180_000);

                disposeComplete = ocr.onComplete((result) => {
                    if (result.requestId !== id) {
                        return;
                    }
                    clearTimeout(timeoutId);
                    resolve(result);
                });
            });

            disposeProgress = ocr.onProgress((progress) => {
                if (progress.requestId === id) {
                    progressEvents.push({requestId: progress.requestId});
                }
            });

            const startResult = await ocr.createSearchablePdf(
                sourcePath,
                [{
                    pageNumber: 1,
                    languages: ['eng'],
                }],
                id,
                150,
            );

            if (!startResult.started) {
                return {
                    requestId: id,
                    started: false,
                    progressEventCount: progressEvents.length,
                    success: false,
                    pdfPath: null,
                    errors: startResult.error ? [startResult.error] : [],
                    startError: startResult.error ?? null,
                    requiresCleanupAck: false,
                };
            }

            const result = await completion;
            return {
                requestId: id,
                started: true,
                progressEventCount: progressEvents.length,
                success: result.success,
                pdfPath: result.pdfPath ?? null,
                sourceDocumentRevisionToken: result.sourceDocumentRevisionToken ?? null,
                errors: result.errors,
                startError: null,
                requiresCleanupAck: Boolean(result.requiresCleanupAck),
            };
        } finally {
            disposeProgress();
            disposeComplete();
        }
    }, {
        sourcePath: sourcePdfPath,
        id: requestId,
    });

    if (!result.success) {
        return {
            ...result,
            recognizedText: null,
        };
    }
    if (!result.pdfPath) {
        throw new Error('OCR reported success without a result PDF path');
    }
    return {
        ...result,
        recognizedText: await assertOcrPdfSemanticOutput(result.pdfPath, expectedText),
    };
}



export async function consumeOcrResultIntoActiveWorkspace(
    page: Page,
    requestId: string,
    pdfPath: string,
    sourceDocumentRevisionToken: string,
) {
    const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(page);
    const result = await callWorkspaceCommand(page, 'handleOcrComplete', [{
        requestId,
        pdfPath,
        sourceDocumentRevisionToken,
        requiresCleanupAck: true,
        sourceWorkingCopyPath: workingCopyPath,
    }]);
    if (!result.called) {
        throw new Error('handleOcrComplete is unavailable on the active workspace');
    }
    return {
        applied: true,
        cleaned: true,
    };
}

export async function rotatePages(page: Page, workingCopyPath: string, pages: number[], totalPages: number, angle: 90 | 180 | 270) {
    return evaluateInPage(page, async ({
        workingPath,
        targetPages,
        expectedTotalPages,
        targetAngle,
    }) => {
        const api = (window as IE2EWindow).electronAPI;

        const rotate = api?.pageOps?.rotate;
        const getDocumentRevision = api?.documentFiles?.getDocumentRevision;
        if (!rotate || !getDocumentRevision) {
            throw new Error('electronAPI page rotation capability is unavailable');
        }
        const revision = await getDocumentRevision(workingPath);
        return rotate(workingPath, targetPages, expectedTotalPages, targetAngle, {expectedDocumentRevisionToken: revision.token});
    }, {
        workingPath: workingCopyPath,
        targetPages: pages,
        expectedTotalPages: totalPages,
        targetAngle: angle,
    });
}
