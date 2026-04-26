import type { Page } from 'puppeteer-core';
import { evaluateInPage } from './page-runtime';

export interface IOcrJobOutcome {
    requestId: string;
    started: boolean;
    progressEventCount: number;
    success: boolean;
    pdfPath: string | null;
    errors: string[];
    startError: string | null;
    requiresCleanupAck: boolean;
}

export async function createWorkingCopyFromPath(page: Page, sourcePath: string, originalPath?: string) {
    return evaluateInPage(page, async ({
        source,
        original,
    }) => {
        const api = (window as Window & {electronAPI?: {documents?: {createWorkingCopyFromPath?: (sourcePath: string, originalPath?: string) => Promise<string>;};};}).electronAPI;

        const createWorkingCopy = api?.documents?.createWorkingCopyFromPath;
        if (typeof createWorkingCopy !== 'function') {
            throw new Error('electronAPI.documents.createWorkingCopyFromPath is unavailable');
        }

        return createWorkingCopy(source, original);
    }, {
        source: sourcePath,
        original: originalPath,
    });
}

export async function getActiveWorkspaceWorkingCopyPath(page: Page) {
    return evaluateInPage(page, () => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        if (!host) {
            throw new Error('Active workspace host not found');
        }

        const workspaceInstance = (host as HTMLElement & {__vueParentComponent?: {setupState?: {workspaceRef?: {value?: {$?: {setupState?: {workingCopyPath?: {value?: string | null;};};};};};};};}).__vueParentComponent?.setupState?.workspaceRef?.value;

        const workingCopyPath = workspaceInstance?.$?.setupState?.workingCopyPath?.value;
        if (typeof workingCopyPath !== 'string' || workingCopyPath.trim().length === 0) {
            throw new Error('workingCopyPath is unavailable on the active workspace');
        }

        return workingCopyPath;
    });
}

export async function runOcrSearchablePdf(page: Page, sourcePdfPath: string, requestId: string): Promise<IOcrJobOutcome> {
    return evaluateInPage(page, async ({
        sourcePath,
        id,
    }) => {
        const api = (window as Window & {electronAPI?: {ocr?: {
            onProgress?: (callback: (progress: {requestId: string;}) => void) => () => void;
            onComplete?: (callback: (result: {
                requestId: string;
                success: boolean;
                pdfPath?: string;
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
}

export async function acknowledgeOcrResult(page: Page, requestId: string, pdfPath: string) {
    return evaluateInPage(page, async ({
        id,
        path,
    }) => {
        const api = (window as Window & {electronAPI?: {ocr?: {acknowledgeResultFile?: (requestId: string, pdfPath?: string) => Promise<{
            cleaned: boolean;
            error?: string 
        }>;};};}).electronAPI;

        if (!api?.ocr?.acknowledgeResultFile) {
            return {
                cleaned: false,
                error: 'acknowledgeResultFile unavailable',
            };
        }

        return api.ocr.acknowledgeResultFile(id, path);
    }, {
        id: requestId,
        path: pdfPath,
    });
}

export async function applyOcrResultToActiveWorkspace(page: Page, pdfPath: string) {
    return evaluateInPage(page, async (path: string) => {
        const api = (window as Window & {electronAPI?: {documents?: {readFile?: (filePath: string) => Promise<ArrayBuffer | Uint8Array>;};};}).electronAPI;

        const readFile = api?.documents?.readFile;
        if (typeof readFile !== 'function') {
            throw new Error('electronAPI.documents.readFile is unavailable');
        }

        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        if (!host) {
            throw new Error('Active workspace host not found');
        }

        const workspaceInstance = (host as HTMLElement & {__vueParentComponent?: {setupState?: {workspaceRef?: { value?: { $?: { setupState?: { handleOcrComplete?: (pdfData: Uint8Array) => Promise<void>; }; }; }; };};};}).__vueParentComponent?.setupState?.workspaceRef?.value;
        const handleOcrComplete = workspaceInstance?.$?.setupState?.handleOcrComplete;
        if (typeof handleOcrComplete !== 'function') {
            throw new Error('handleOcrComplete is unavailable on the active workspace');
        }

        const bytes = new Uint8Array(await readFile(path));
        await handleOcrComplete(bytes);
        return true;
    }, pdfPath);
}

export async function consumeOcrResultIntoActiveWorkspace(page: Page, requestId: string, pdfPath: string) {
    return evaluateInPage(page, async ({
        id,
        path,
    }) => {
        const api = (window as Window & {electronAPI?: {
            documents?: {readFile?: (filePath: string) => Promise<ArrayBuffer | Uint8Array>;};
            ocr?: {acknowledgeResultFile?: (requestId: string, pdfPath?: string) => Promise<{
                cleaned: boolean;
                error?: string;
            }>;};
        };}).electronAPI;

        const readFile = api?.documents?.readFile;
        if (typeof readFile !== 'function') {
            throw new Error('electronAPI.documents.readFile is unavailable');
        }

        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        if (!host) {
            throw new Error('Active workspace host not found');
        }

        const workspaceInstance = (host as HTMLElement & {__vueParentComponent?: {setupState?: {workspaceRef?: { value?: { $?: { setupState?: { handleOcrComplete?: (pdfData: Uint8Array) => Promise<void>; }; }; }; };};};}).__vueParentComponent?.setupState?.workspaceRef?.value;
        const handleOcrComplete = workspaceInstance?.$?.setupState?.handleOcrComplete;
        if (typeof handleOcrComplete !== 'function') {
            throw new Error('handleOcrComplete is unavailable on the active workspace');
        }

        const bytes = new Uint8Array(await readFile(path));
        const acknowledgeResultFile = api?.ocr?.acknowledgeResultFile;
        let cleanupResult: {
            cleaned: boolean;
            error?: string;
        } | null = null;

        if (typeof acknowledgeResultFile === 'function') {
            cleanupResult = await acknowledgeResultFile(id, path);
            if (!cleanupResult.cleaned && cleanupResult.error) {
                throw new Error(cleanupResult.error);
            }
        }

        await handleOcrComplete(bytes);
        return {
            applied: true,
            cleaned: cleanupResult?.cleaned ?? false,
        };
    }, {
        id: requestId,
        path: pdfPath,
    });
}

export async function rotatePages(page: Page, workingCopyPath: string, pages: number[], angle: 90 | 180 | 270) {
    return evaluateInPage(page, async ({
        workingPath,
        targetPages,
        targetAngle,
    }) => {
        const api = (window as Window & {electronAPI?: {documents?: {pageOps?: {rotate?: (workingCopyPath: string, pages: number[], angle: 90 | 180 | 270) => Promise<{ success: boolean }>;};};};}).electronAPI;

        const rotate = api?.documents?.pageOps?.rotate;
        if (!rotate) {
            throw new Error('electronAPI.documents.pageOps.rotate is unavailable');
        }
        return rotate(workingPath, targetPages, targetAngle);
    }, {
        workingPath: workingCopyPath,
        targetPages: pages,
        targetAngle: angle,
    });
}

export async function reorderPages(page: Page, workingCopyPath: string, newOrder: number[]) {
    return evaluateInPage(page, async ({
        workingPath,
        order,
    }) => {
        const api = (window as Window & {electronAPI?: {documents?: {pageOps?: {reorder?: (workingCopyPath: string, newOrder: number[]) => Promise<{
            success: boolean;
            pageCount?: number 
        }>;};};};}).electronAPI;

        const reorder = api?.documents?.pageOps?.reorder;
        if (!reorder) {
            throw new Error('electronAPI.documents.pageOps.reorder is unavailable');
        }
        return reorder(workingPath, order);
    }, {
        workingPath: workingCopyPath,
        order: newOrder,
    });
}

export async function deletePages(page: Page, workingCopyPath: string, pages: number[], totalPages: number) {
    return evaluateInPage(page, async ({
        workingPath,
        targetPages,
        pageCount,
    }) => {
        const api = (window as Window & {electronAPI?: {documents?: {pageOps?: {delete?: (workingCopyPath: string, pages: number[], totalPages: number) => Promise<{
            success: boolean;
            pageCount?: number 
        }>;};};};}).electronAPI;

        const remove = api?.documents?.pageOps?.delete;
        if (!remove) {
            throw new Error('electronAPI.documents.pageOps.delete is unavailable');
        }
        return remove(workingPath, targetPages, pageCount);
    }, {
        workingPath: workingCopyPath,
        targetPages: pages,
        pageCount: totalPages,
    });
}

export async function openDjvuForViewing(page: Page, djvuPath: string) {
    return evaluateInPage(page, async (sourcePath: string) => {
        const api = (window as Window & {electronAPI?: {djvu?: {openForViewing?: (path: string) => Promise<{
            success: boolean;
            pdfPath?: string;
            pageCount?: number;
            error?: string 
        }>;};};}).electronAPI;

        const openForViewing = api?.djvu?.openForViewing;
        if (!openForViewing) {
            throw new Error('electronAPI.djvu.openForViewing is unavailable');
        }

        return openForViewing(sourcePath);
    }, djvuPath);
}
