import type { IDocumentsCapability } from '@contracts/platform-api';
import {
    OPEN_PDF_IMAGE_ACCEPT,
    buildOpenPdfImagePickerTypes,
} from '@app/platform/browser-api/common';
import {
    createBrowserDocumentsFileCapability,
    createCombinedPdfFromPaths,
    pickFiles,
    saveBytesToPickerOrDownload,
} from '@app/platform/browser-api/documents-file-capability';
import { createBrowserImageExportCapability } from '@app/platform/browser-api/documents-image-export-capability';
import { browserDocumentsMenuCapability } from '@app/platform/browser-api/documents-menu-capability';
import { createBrowserPageOps } from '@app/platform/browser-api/documents-page-ops';

interface ICreateBrowserDocumentsCapabilityOptions {clearSearchCaches: () => void;}

export function createBrowserDocumentsCapability(
    options: ICreateBrowserDocumentsCapabilityOptions,
): IDocumentsCapability {
    const fileCapability = createBrowserDocumentsFileCapability(options);
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
            saveBytesToPickerOrDownload,
        }),
    };
}
