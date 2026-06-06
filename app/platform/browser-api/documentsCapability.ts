import type {
    IDocumentsCapability,
    IImageExportCapability,
    IPageOpsCapability,
} from '@contracts/platformApi';
import {
    OPEN_PDF_IMAGE_ACCEPT,
    buildOpenPdfImagePickerTypes,
} from '@app/platform/browser-api/browserFileAccepts';
import {
    createBrowserDocumentsFileCapability,
    createCombinedPdfFromPaths,
} from '@app/platform/browser-api/documentsFileCapability';
import {
    configureBrowserFilePickerMessages,
    pickFiles,
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import { createBrowserImageExportCapability } from '@app/platform/browser-api/documentsImageExportCapability';
import { browserDocumentsMenuCapability } from '@app/platform/browser-api/documentsMenuCapability';
import { createBrowserPageOpsCapability } from '@app/platform/browser-api/documentsPageOpsCapability';
import {
    DEFAULT_LOCALE,
    LOCALE_MESSAGES,
} from '@i18n-app';
import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';

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
        ? decodeURIComponent(cookieMatch[1])
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

export function createBrowserDocumentsCapability(
    options: ICreateBrowserDocumentsCapabilityOptions,
): IBrowserDocumentCapabilities {
    const errorMessageProvider = { largeSaveHandleHint: () => translateBrowserMessage('errors.browser.largeSaveHandleHint') };
    configureBrowserFilePickerMessages(errorMessageProvider);
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
        createCombinedPdfFromPaths,
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
