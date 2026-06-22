import type {
    IDocumentsCapability,
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
    const documentsCapability = {
        ...fileCapability,
        ...browserDocumentsMenuCapability,
    };

    return {
        documents: documentsCapability,
        imageExport: imageExportCapability,
        pageOps: pageOpsCapability,
    };
}
