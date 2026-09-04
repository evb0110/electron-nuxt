import type { IOwnedProcessRecord } from '@scripts/windows-test/guest/appLaunch';

export const viewerDefaultTimeouts = {
    startupMs: 75_000,
    operationMs: 45_000,
    uiStepMs: 30_000,
    printReadinessMs: 120_000,
} as const;

export type TViewerKey =
    | 'AltLeft'
    | 'ArrowDown'
    | 'ArrowLeft'
    | 'ArrowRight'
    | 'ArrowUp'
    | 'Backspace'
    | 'ControlLeft'
    | 'Delete'
    | 'End'
    | 'Enter'
    | 'Escape'
    | 'F4'
    | 'F6'
    | 'Home'
    | 'KeyN'
    | 'KeyO'
    | 'KeyP'
    | 'KeyS'
    | 'ShiftLeft'
    | 'Space'
    | 'Tab';

export interface IViewerOperationOutcome {
    success: boolean;
    errorCode: string | null;
    pageCount: number | null;
}

export interface IViewerDriver {
    openDocument(filePath: string): Promise<void>;
    waitUntilReady(): Promise<void>;
    workingCopyPath(): Promise<string>;
    totalPages(): Promise<number>;
    deletePage(pageNumber: number): Promise<IViewerOperationOutcome>;
    save(): Promise<IViewerOperationOutcome>;
    documentRevisionToken(): Promise<string>;
    deletePageUsingRevisionToken(pageNumber: number, revisionToken: string): Promise<IViewerOperationOutcome>;
    requestSaveAs(): Promise<void>;
    requestSaveAsCommand(): Promise<void>;
    requestPrint(): Promise<void>;
    printDocumentCommand(): Promise<void>;
    isPreparingPrint(): Promise<boolean>;
    createAnnotation(text: string): Promise<number>;
    countTextMatches(filePath: string, query: string): Promise<number>;
    pressKeys(keys: readonly TViewerKey[]): Promise<void>;
    captureScreenshot(filePath: string): Promise<void>;
    rendererFailures(): string[];
}

export interface IViewerSession {
    driver: IViewerDriver;
    process: IOwnedProcessRecord;
    close(): Promise<void>;
}

export interface IAcceptanceAppSession {
    process: IOwnedProcessRecord;
    close(): Promise<void>;
}

export interface IViewerFactory {
    openInstrumented(documentPath: string): Promise<IViewerSession>;
    launchAcceptance(documentPath?: string): Promise<IAcceptanceAppSession>;
}
