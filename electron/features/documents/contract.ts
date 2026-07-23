import type {
    IDocumentMutationRevisionOptions,
    IDocumentsFileCapability,
    IPdfNativePagePreviewOptions,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
    IPdfOptimizeOptions,
} from '@contracts/electronApiDocuments';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';
export const DOCUMENTS_CHANNELS = {
    openDocumentDirect: 'dialog:openPdfDirect',
    openPdfDirect: 'dialog:openPdfDirect',
    openDocumentDirectBatch: 'dialog:openPdfDirectBatch',
    openPdfDirectBatch: 'dialog:openPdfDirectBatch',
    cancelOpenDocumentDirectBatch: 'dialog:openPdfDirectBatch:cancel',
    registerRendererFileOpenToken: 'dialog:registerRendererFileOpenToken',
    registerRendererFileOpenTokens: 'dialog:registerRendererFileOpenTokens',
    allowRendererFileOpen: 'dialog:allowRendererFileOpen',
    allowRendererFileOpenBatch: 'dialog:allowRendererFileOpenBatch',
    createWorkingCopyFromData: 'working-copy:createFromData',
    createWorkingCopyFromPath: 'working-copy:createFromPath',
    savePdfAs: 'dialog:savePdfAs',
    savePdfDataAs: 'dialog:savePdfDataAs',
    savePdfDataAsBegin: 'dialog:savePdfDataAs:begin',
    savePdfDialog: 'dialog:savePdfDialog',
    saveDocxAs: 'dialog:saveDocxAs',
    fileRead: 'file:read',
    fileStat: 'file:stat',
    fileReadRange: 'file:readRange',
    fileCreateManagedHandle: 'file:createManagedHandle',
    fileReleaseManagedHandle: 'file:releaseManagedHandle',
    pdfOpeningGeometry: 'pdf:openingGeometry',
    pdfNativePageSizes: 'pdf:nativePageSizes',
    pdfNativePagePreviewCancel: 'pdf:nativePagePreview:cancel',
    pdfNativePagePreview: 'pdf:nativePagePreview',
    fileReadText: 'file:readText',
    fileExists: 'file:exists',
    documentRevisionGet: 'document:revision:get',
    pdfAnalyzeConformance: 'pdf:analyzeConformance',
    pdfValidateData: 'pdf:validateData',
    pdfValidatePath: 'pdf:validatePath',
    pdfOpenInDefaultAppData: 'pdf:openInDefaultAppData',
    pdfOpenInDefaultAppPath: 'pdf:openInDefaultAppPath',
    pdfPrintData: 'pdf:printData',
    pdfPrintPath: 'pdf:printPath',
    fileWrite: 'file:write',
    fileReplaceWorkingCopyFromPath: 'file:replaceWorkingCopyFromPath',
    fileWriteDocx: 'file:writeDocx',
    fileSaveStructured: 'file:saveStructured',
    fileResyncWorkingCopy: 'file:resyncWorkingCopy',
    fileRepairPdf: 'file:repairPdf',
    fileOptimizePdfForInteraction: 'file:optimizePdfForInteraction',
    fileOptimizePdfAsCopy: 'file:optimizePdfAsCopy',
    fileSavePdfData: 'file:savePdfData',
    fileSavePdfDataBegin: 'file:savePdfData:begin',
    fileSavePdfDataPort: 'file:savePdfData:port',
    fileSavePdfNoteTextUpdates: 'file:savePdfNoteTextUpdates',
    fileSavePdfNoteChanges: 'file:savePdfNoteChanges',
    fileSavePdfNativeMutations: 'file:savePdfNativeMutations',
    fileApplyPdfNativeMutationsToWorkingCopy: 'file:applyPdfNativeMutationsToWorkingCopy',
    fileCommitStagedPdfNativeMutations: 'file:commitStagedPdfNativeMutations',
    fileCleanup: 'file:cleanup',
    fileCleanupOcrTemp: 'file:cleanupOcrTemp',
} as const;

export const DOCUMENTS_EVENT_CHANNELS = {documentRevisionChanged: 'document:revision:changed'} as const;

export interface IDocumentsInvokeMap {
    [DOCUMENTS_CHANNELS.openDocumentDirect]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['openDocumentDirect']>>;
    };
    [DOCUMENTS_CHANNELS.openDocumentDirectBatch]: {
        args: [paths: string[], requestId?: string, options?: {forceCombine?: boolean}];
        result: Awaited<ReturnType<IDocumentsFileCapability['openDocumentDirectBatch']>>;
    };
    [DOCUMENTS_CHANNELS.cancelOpenDocumentDirectBatch]: {
        args: [requestId: string];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.registerRendererFileOpenToken]: {
        args: [token: string];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.registerRendererFileOpenTokens]: {
        args: [tokens: string[]];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpen]: {
        args: [request: {
            filePath: string;
            token: string;
        }];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpenBatch]: {
        args: [requests: Array<{
            filePath: string;
            token: string;
        }>];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.createWorkingCopyFromData]: {
        args: [fileName: string, data: Uint8Array, originalPath?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['createWorkingCopyFromData']>>;
    };
    [DOCUMENTS_CHANNELS.createWorkingCopyFromPath]: {
        args: [sourcePath: string, originalPath?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['createWorkingCopyFromPath']>>;
    };
    [DOCUMENTS_CHANNELS.savePdfAs]: {
        args: [workingPath: string, options: IPdfSaveAsOptions | undefined, revisionOptions?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfAs']>>;
    };
    [DOCUMENTS_CHANNELS.savePdfDataAs]: {
        args: [
            workingPath: string,
            data: Uint8Array,
            options?: IPdfSaveAsOptions,
            serializedSaveOptions?: IPdfSerializedSaveOptions,
        ];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfDataAs']>>;
    };
    [DOCUMENTS_CHANNELS.savePdfDataAsBegin]: {
        args: [
            workingPath: string,
            totalBytes: number,
            options?: IPdfSaveAsOptions,
            serializedSaveOptions?: IPdfSerializedSaveOptions,
        ];
        result: IBeginSerializedPdfSaveAsResult;
    };
    [DOCUMENTS_CHANNELS.savePdfDialog]: {
        args: [suggestedName: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfDialog']>>;
    };
    [DOCUMENTS_CHANNELS.saveDocxAs]: {
        args: [workingPath: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['saveDocxAs']>>;
    };
    [DOCUMENTS_CHANNELS.fileRead]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['readFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileStat]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['statFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileReadRange]: {
        args: [path: string, offset: number, length: number];
        result: Awaited<ReturnType<IDocumentsFileCapability['readFileRange']>>;
    };
    [DOCUMENTS_CHANNELS.fileCreateManagedHandle]: {
        args: [path: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['createManagedTempFileHandle']>>>;
    };
    [DOCUMENTS_CHANNELS.fileReleaseManagedHandle]: {
        args: [leaseId: string];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.pdfOpeningGeometry]: {
        args: [path: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['getPdfOpeningGeometry']>>>;
    };
    [DOCUMENTS_CHANNELS.pdfNativePageSizes]: {
        args: [path: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['getPdfNativePageSizes']>>>;
    };
    [DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel]: {
        args: [requestId: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['cancelPdfNativePagePreview']>>>;
    };
    [DOCUMENTS_CHANNELS.pdfNativePagePreview]: {
        args: [path: string, pageNumber: number, options?: IPdfNativePagePreviewOptions];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['renderPdfNativePagePreview']>>>;
    };
    [DOCUMENTS_CHANNELS.fileReadText]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['readTextFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileExists]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['fileExists']>>;
    };
    [DOCUMENTS_CHANNELS.documentRevisionGet]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['getDocumentRevision']>>;
    };
    [DOCUMENTS_CHANNELS.pdfAnalyzeConformance]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['analyzePdfConformance']>>;
    };
    [DOCUMENTS_CHANNELS.pdfValidateData]: {
        args: [data: Uint8Array, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
    };
    [DOCUMENTS_CHANNELS.pdfValidatePath]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['validatePdfPath']>>;
    };
    [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData]: {
        args: [data: Uint8Array, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['openPdfInDefaultAppData']>>;
    };
    [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath]: {
        args: [path: string, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['openPdfInDefaultAppPath']>>;
    };
    [DOCUMENTS_CHANNELS.pdfPrintData]: {
        args: [data: Uint8Array, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['printPdfData']>>;
    };
    [DOCUMENTS_CHANNELS.pdfPrintPath]: {
        args: [path: string, fileName?: string, pageNumbers?: number[]];
        result: Awaited<ReturnType<IDocumentsFileCapability['printPdfPath']>>;
    };
    [DOCUMENTS_CHANNELS.fileWrite]: {
        args: [path: string, data: Uint8Array, options?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['writeFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath]: {
        args: [workingCopyPath: string, sourcePath: string, options?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['replaceWorkingCopyFromPath']>>;
    };
    [DOCUMENTS_CHANNELS.fileWriteDocx]: {
        args: [path: string, data: Uint8Array];
        result: Awaited<ReturnType<IDocumentsFileCapability['writeDocxFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileSaveStructured]: {
        args: [path: string, options?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['saveFileStructured']>>;
    };
    [DOCUMENTS_CHANNELS.fileResyncWorkingCopy]: {
        args: [path: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['resyncWorkingCopy']>>>;
    };
    [DOCUMENTS_CHANNELS.fileRepairPdf]: {
        args: [path: string, options?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['repairPdf']>>>;
    };
    [DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction]: {
        args: [path: string, options?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['optimizePdfForInteraction']>>>;
    };
    [DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy]: {
        args: [
            path: string,
            options: IPdfOptimizeOptions,
            requestId?: string,
            revisionOptions?: IDocumentMutationRevisionOptions,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['optimizePdfAsCopy']>>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfData]: {
        args: [path: string, data: Uint8Array, options?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfData']>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: {
        args: [path: string, totalBytes: number, options?: IPdfSerializedSaveOptions];
        result: IBeginSerializedPdfPersistenceResult;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates]: {
        args: [
            path: string,
            updates: Parameters<NonNullable<IDocumentsFileCapability['savePdfNoteTextUpdates']>>[1],
            modifiedAt: string,
            options?: IPdfSerializedSaveOptions,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['savePdfNoteTextUpdates']>>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfNoteChanges]: {
        args: [
            path: string,
            changes: Parameters<NonNullable<IDocumentsFileCapability['savePdfNoteChanges']>>[1],
            modifiedAt: string,
            options?: IPdfSerializedSaveOptions,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['savePdfNoteChanges']>>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfNativeMutations]: {
        args: [
            path: string,
            mutations: Parameters<NonNullable<IDocumentsFileCapability['savePdfNativeMutations']>>[1],
            modifiedAt: string,
            options?: IPdfSerializedSaveOptions,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['savePdfNativeMutations']>>>;
    };
    [DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy]: {
        args: [
            path: string,
            mutations: Parameters<NonNullable<IDocumentsFileCapability['applyPdfNativeMutationsToWorkingCopy']>>[1],
            modifiedAt: string,
            expectedBase: Parameters<NonNullable<IDocumentsFileCapability['applyPdfNativeMutationsToWorkingCopy']>>[3],
            options?: IPdfSerializedSaveOptions,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['applyPdfNativeMutationsToWorkingCopy']>>>;
    };
    [DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations]: {
        args: [
            path: string,
            stagedOutput: Parameters<NonNullable<IDocumentsFileCapability['commitStagedPdfNativeMutations']>>[1],
            options?: IPdfSerializedSaveOptions,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['commitStagedPdfNativeMutations']>>>;
    };
    [DOCUMENTS_CHANNELS.fileCleanup]: {
        args: [path: string];
        result: undefined;
    };
    [DOCUMENTS_CHANNELS.fileCleanupOcrTemp]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['cleanupOcrTemp']>>;
    };
}


export type { TOpenFileResult } from '@contracts/electronApiDocuments';
