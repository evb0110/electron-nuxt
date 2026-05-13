import type { IDocumentsCapability } from '@contracts/platformApi';
import {
    OPEN_PDF_IMAGE_ACCEPT,
    buildOpenPdfImagePickerTypes,
} from '@app/platform/browser-api/common';
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
import { createBrowserPageOps } from '@app/platform/browser-api/documentsPageOps';
import {
    DEFAULT_LOCALE,
    LOCALE_MESSAGES,
    type TLocale,
    type TTranslateFn,
} from '@i18n-app';
import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';

interface ICreateBrowserDocumentsCapabilityOptions {clearSearchCaches: () => void;}

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
): IDocumentsCapability {
    const errorMessageProvider = { largeSaveHandleHint: () => translateBrowserMessage('errors.browser.largeSaveHandleHint') };
    configureBrowserFilePickerMessages(errorMessageProvider);
    const fileCapability = createBrowserDocumentsFileCapability({
        ...options,
        errorMessageProvider,
    });
    const imageExportCapability = createBrowserImageExportCapability();

    return {
        ...fileCapability,
        ...imageExportCapability,
        ...browserDocumentsMenuCapability,
        pageOps: createBrowserPageOps({
            clearSearchCaches: options.clearSearchCaches,
            openInputAccept: OPEN_PDF_IMAGE_ACCEPT,
            pickFiles,
            buildOpenPdfPickerTypes: buildOpenPdfImagePickerTypes,
            createCombinedPdfFromPaths,
            pickSaveTarget,
            saveBytesToPickerOrDownload,
            writeBytesToHandle,
        }),
    };
}
