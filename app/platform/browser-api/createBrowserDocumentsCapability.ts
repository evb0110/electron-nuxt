import type {
    IDocumentsCapability,
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
    IImageExportCapability,
} from '@contracts/electronApiDocuments';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import {
    OPEN_PDF_IMAGE_ACCEPT,
    buildOpenPdfImagePickerTypes,
    configureBrowserFilePickerDescriptions,
} from '@app/platform/browser-api/browserFileAccepts';
import type { TBrowserFilePickerDescriptionKey } from '@app/platform/browser-api/browserFileAccepts';
import {
    createBrowserCombinedPdfFromPaths,
    createBrowserDocumentsFileCapability,
} from '@app/platform/browser-api/createBrowserDocumentsFileCapability';
import {
    configureBrowserFilePickerMessages,
    pickFiles,
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import { createBrowserImageExportCapability } from '@app/platform/browser-api/createBrowserImageExportCapability';
import { browserDocumentsMenuCapability } from '@app/platform/browser-api/documentsMenuCapability';
import { createBrowserPageOpsCapability } from '@app/platform/browser-api/createBrowserPageOpsCapability';
import {
    DEFAULT_LOCALE,
    LOCALE_MESSAGES,
} from '@i18n-app';
import type {
    TLocale,
    TTranslateFn,
    TTranslationKey,
} from '@i18n-app';
import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';

interface ICreateBrowserDocumentsCapabilityOptions {clearSearchCaches: (pdfPath?: string) => void;}

export interface IBrowserDocumentCapabilities {
    documents: IDocumentsCapability;
    documentPicker: IDocumentsPickerCapability;
    documentOpen: IDocumentsOpenCapability;
    documentWorkingCopy: IDocumentsWorkingCopyCapability;
    documentFiles: IDocumentsFileIoCapability;
    documentPdf: IDocumentsPdfCapability;
    documentRecentFiles: IDocumentsRecentFilesCapability;
    documentWindow: IDocumentsWindowCapability;
    documentMenu: IDocumentsMenuCapability;
    imageExport: IImageExportCapability;
    pageOps: IPageOpsCapability;
}

function getBrowserLocale(): TLocale {
    const cookieMatch = typeof document !== 'undefined'
        ? document.cookie.match(/(?:^|;\s*)i18n_redirected=([^;]+)/u)
        : null;
    const cookieLocale = cookieMatch?.[1]
        ? safeDecodeURIComponent(cookieMatch[1])
        : null;

    if (cookieLocale && cookieLocale in LOCALE_MESSAGES) {
        return cookieLocale as TLocale;
    }

    const navigatorLocale = typeof navigator !== 'undefined'
        ? navigator.language.split('-')[0]
        : null;
    return navigatorLocale && navigatorLocale in LOCALE_MESSAGES
        ? navigatorLocale as TLocale
        : DEFAULT_LOCALE;
}

const translateBrowserMessage: TTranslateFn = (key, ...args) => {
    const params = normalizeTranslationParams(args[0]);
    const locale = getBrowserLocale();
    const messages = LOCALE_MESSAGES[locale] ?? LOCALE_MESSAGES[DEFAULT_LOCALE];
    const fallbackMessages = LOCALE_MESSAGES[DEFAULT_LOCALE];
    const leaf = getNestedTranslationLeaf(messages, key)
        ?? getNestedTranslationLeaf(fallbackMessages, key)
        ?? key;

    return formatTranslationLeaf(leaf, params, locale);
};

const BROWSER_FILE_PICKER_DESCRIPTION_MESSAGE_KEYS = {
    documents: 'browser.filePicker.documents',
    images: 'browser.filePicker.images',
    pdfDocuments: 'browser.filePicker.pdfDocuments',
    wordDocuments: 'browser.filePicker.wordDocuments',
    jpegImages: 'browser.filePicker.jpegImages',
    pngImages: 'browser.filePicker.pngImages',
    tiffImages: 'browser.filePicker.tiffImages',
} as const satisfies Record<TBrowserFilePickerDescriptionKey, TTranslationKey>;

export function createBrowserDocumentsCapability(
    options: ICreateBrowserDocumentsCapabilityOptions,
): IBrowserDocumentCapabilities {
    const errorMessageProvider = { largeSaveHandleHint: () => translateBrowserMessage('errors.browser.largeSaveHandleHint') };
    configureBrowserFilePickerMessages(errorMessageProvider);
    configureBrowserFilePickerDescriptions((key) =>
        translateBrowserMessage(BROWSER_FILE_PICKER_DESCRIPTION_MESSAGE_KEYS[key]),
    );
    const fileCapability = createBrowserDocumentsFileCapability({
        ...options,
        errorMessageProvider,
    });
    const imageExportCapability = createBrowserImageExportCapability();
    const pageOpsCapability = createBrowserPageOpsCapability({
        clearSearchCaches: options.clearSearchCaches,
        openInputAccept: OPEN_PDF_IMAGE_ACCEPT,
        pickFiles,
        buildOpenPdfPickerTypes: buildOpenPdfImagePickerTypes,
        createCombinedPdfFromPaths: createBrowserCombinedPdfFromPaths,
        pickSaveTarget,
        saveBytesToPickerOrDownload,
        writeBytesToHandle,
    });
    const documentPicker = {
        openDocumentDialog: fileCapability.openDocumentDialog,
        openPdfDialog: fileCapability.openPdfDialog,
        openCombineDialog: fileCapability.openCombineDialog,
        openFolderDialog: fileCapability.openFolderDialog,
        ...(fileCapability.openFolderDialogStructured
            ? {openFolderDialogStructured: fileCapability.openFolderDialogStructured}
            : {}),
        openImageDialog: fileCapability.openImageDialog,
        getPathForFile: fileCapability.getPathForFile,
        getPathsForFiles: fileCapability.getPathsForFiles,
    } satisfies IDocumentsPickerCapability;
    const documentOpen = {
        openDocumentDirect: fileCapability.openDocumentDirect,
        openPdfDirect: fileCapability.openPdfDirect,
        openDocumentDirectBatch: fileCapability.openDocumentDirectBatch,
        openPdfDirectBatch: fileCapability.openPdfDirectBatch,
    } satisfies IDocumentsOpenCapability;
    const documentWorkingCopy = {
        createWorkingCopyFromData: fileCapability.createWorkingCopyFromData,
        createWorkingCopyFromPath: fileCapability.createWorkingCopyFromPath,
        cleanupFile: fileCapability.cleanupFile,
        cleanupOcrTemp: fileCapability.cleanupOcrTemp,
    } satisfies IDocumentsWorkingCopyCapability;
    const optionalDocumentFileMethods = {
        ...(fileCapability.saveFileStructured ? {saveFileStructured: fileCapability.saveFileStructured} : {}),
        ...(fileCapability.repairPdf ? {repairPdf: fileCapability.repairPdf} : {}),
        ...(fileCapability.optimizePdfForInteraction ? {optimizePdfForInteraction: fileCapability.optimizePdfForInteraction} : {}),
        ...(fileCapability.optimizePdfAsCopy ? {optimizePdfAsCopy: fileCapability.optimizePdfAsCopy} : {}),
        ...(fileCapability.savePdfNoteTextUpdates ? {savePdfNoteTextUpdates: fileCapability.savePdfNoteTextUpdates} : {}),
        ...(fileCapability.savePdfNoteChanges ? {savePdfNoteChanges: fileCapability.savePdfNoteChanges} : {}),
        ...(fileCapability.savePdfNativeMutations ? {savePdfNativeMutations: fileCapability.savePdfNativeMutations} : {}),
        ...(fileCapability.applyPdfNativeMutationsToWorkingCopy
            ? {applyPdfNativeMutationsToWorkingCopy: fileCapability.applyPdfNativeMutationsToWorkingCopy}
            : {}),
    };
    const documentFiles = {
        readFile: fileCapability.readFile,
        statFile: fileCapability.statFile,
        readFileRange: fileCapability.readFileRange,
        readFileChunks: fileCapability.readFileChunks,
        readTextFile: fileCapability.readTextFile,
        fileExists: fileCapability.fileExists,
        getDocumentRevision: fileCapability.getDocumentRevision,
        onDocumentRevisionChanged: fileCapability.onDocumentRevisionChanged,
        savePdfAs: fileCapability.savePdfAs,
        savePdfDataAs: fileCapability.savePdfDataAs,
        savePdfDialog: fileCapability.savePdfDialog,
        saveDocxAs: fileCapability.saveDocxAs,
        writeFile: fileCapability.writeFile,
        replaceWorkingCopyFromPath: fileCapability.replaceWorkingCopyFromPath,
        writeDocxFile: fileCapability.writeDocxFile,
        saveFile: fileCapability.saveFile,
        savePdfData: fileCapability.savePdfData,
        savePdfDataChunks: fileCapability.savePdfDataChunks,
        ...optionalDocumentFileMethods,
    } satisfies IDocumentsFileIoCapability;
    const documentPdf = {
        analyzePdfConformance: fileCapability.analyzePdfConformance,
        validatePdfData: fileCapability.validatePdfData,
        validatePdfPath: fileCapability.validatePdfPath,
        openPdfInDefaultAppData: fileCapability.openPdfInDefaultAppData,
        openPdfInDefaultAppPath: fileCapability.openPdfInDefaultAppPath,
        printPdfData: fileCapability.printPdfData,
        printPdfPath: fileCapability.printPdfPath,
    } satisfies IDocumentsPdfCapability;
    const documentRecentFiles = {recentFiles: fileCapability.recentFiles} satisfies IDocumentsRecentFilesCapability;
    const documentWindow = {
        setWindowTitle: fileCapability.setWindowTitle,
        showItemInFolder: fileCapability.showItemInFolder,
        ...(fileCapability.showItemInFolderStructured
            ? {showItemInFolderStructured: fileCapability.showItemInFolderStructured}
            : {}),
    } satisfies IDocumentsWindowCapability;
    const documentMenu = {...browserDocumentsMenuCapability} satisfies IDocumentsMenuCapability;
    const documentsCapability = {
        ...documentPicker,
        ...documentOpen,
        ...documentWorkingCopy,
        ...documentFiles,
        ...documentPdf,
        ...documentRecentFiles,
        ...documentWindow,
        ...documentMenu,
    };

    return {
        documents: documentsCapability,
        documentPicker,
        documentOpen,
        documentWorkingCopy,
        documentFiles,
        documentPdf,
        documentRecentFiles,
        documentWindow,
        documentMenu,
        imageExport: imageExportCapability,
        pageOps: pageOpsCapability,
    };
}
