import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TTranslateFn } from '@i18n-app';
import type { IDocxExportFileCapability } from '@contracts/docxExport';
import type { TDocxTextPageSource } from '@app/utils/docxStreaming';
import {
    getDocumentRefBaseName,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import {
    loadDocumentTextCatalogPages,
    prepareDocumentTextCatalogTextPages,
} from '@app/utils/ocr/loadOcrText';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';

type TDocxBuilder = (text: string, hasRtl: boolean) => Uint8Array | Promise<Uint8Array>;
type TDocxChunkBuilder = (
    pages: TDocxTextPageSource,
    hasRtl: boolean,
) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;

const BROWSER_DOCX_MAX_TEXT_CHARACTERS = 3 * 1024 * 1024;
const BROWSER_DOCX_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function* getNonEmptyPageTexts(
    catalogPages: Array<{text: string}> | null,
): Generator<string> {
    for (const page of catalogPages ?? []) {
        const pageText = page.text.trim();
        if (pageText) {
            yield pageText;
        }
    }
}

function hasNonEmptyPage(catalogPages: Array<{text: string}> | null) {
    return (catalogPages ?? []).some(page => page.text.trim().length > 0);
}

export async function exportTextAsDocx(params: {
    workingCopyPath: TDocumentRef | null;
    documentRevisionToken: TDocumentRevisionToken | null;
    pdfDocument: PDFDocumentProxy | null;
    hasRtl: boolean;
    buildDocx: TDocxBuilder;
    buildDocxChunks?: TDocxChunkBuilder;
    t: TTranslateFn;
    toast: ReturnType<typeof useToast>;
    setError: (message: string) => void;
    localizeError: (error: unknown) => string;
    onSuccess?: () => void;
}) {
    try {
        const documentFiles = getDocumentFilesCapability();
        const documentWorkingCopy = getDocumentWorkingCopyCapability();
        const workingPath = params.workingCopyPath ?? '';
        const outPath = await documentFiles.saveDocxAs(workingPath);
        if (!outPath) {
            return false;
        }

        try {
            const isBrowserOutput = isBrowserDocumentRef(outPath);
            const pageCount = params.pdfDocument?.numPages;
            const knownPageCount = typeof pageCount === 'number'
                && Number.isSafeInteger(pageCount)
                && pageCount > 0
                ? pageCount
                : undefined;
            const writeDocxFileChunks = !isBrowserOutput
                ? (documentFiles as typeof documentFiles & Partial<IDocxExportFileCapability>)
                    .writeDocxFileChunks
                : undefined;
            if (
                !isBrowserOutput
                && params.workingCopyPath
                && params.documentRevisionToken
                && knownPageCount !== undefined
                && params.buildDocxChunks
                && writeDocxFileChunks
            ) {
                const textPages = await prepareDocumentTextCatalogTextPages(
                    params.workingCopyPath,
                    params.documentRevisionToken,
                    knownPageCount,
                );
                if (!textPages) {
                    params.setError(params.t('errors.ocr.noText'));
                    return false;
                }
                const docxChunks = await params.buildDocxChunks(
                    textPages,
                    params.hasRtl,
                );
                await writeDocxFileChunks(outPath, docxChunks);
            } else {
                const catalogPages = params.workingCopyPath && params.documentRevisionToken
                    ? await loadDocumentTextCatalogPages(
                        params.workingCopyPath,
                        params.documentRevisionToken,
                        knownPageCount,
                    )
                    : null;
                if (!hasNonEmptyPage(catalogPages)) {
                    params.setError(params.t('errors.ocr.noText'));
                    return false;
                }

                if (!isBrowserOutput) {
                    if (!params.buildDocxChunks || !writeDocxFileChunks) {
                        throw new Error('DOCX streaming output is unavailable on this desktop platform');
                    }
                    const docxChunks = await params.buildDocxChunks(
                        getNonEmptyPageTexts(catalogPages),
                        params.hasRtl,
                    );
                    await writeDocxFileChunks(outPath, docxChunks);
                } else {
                    let catalogTextLength = 0;
                    const catalogTextParts: string[] = [];
                    for (const page of catalogPages ?? []) {
                        const pageText = page.text.trim();
                        if (!pageText) continue;
                        catalogTextLength += pageText.length + (catalogTextParts.length > 0 ? 2 : 0);
                        if (catalogTextLength > BROWSER_DOCX_MAX_TEXT_CHARACTERS) {
                            throw new RangeError('Browser DOCX export text exceeds its bounded Blob budget');
                        }
                        catalogTextParts.push(pageText);
                    }
                    const text = catalogTextParts.join('\n\n');
                    const docxBytes = await params.buildDocx(text, params.hasRtl);
                    if (docxBytes.byteLength > BROWSER_DOCX_MAX_OUTPUT_BYTES) {
                        throw new RangeError('Browser DOCX export exceeds its bounded Blob size');
                    }
                    await documentFiles.writeDocxFile(outPath, docxBytes);
                }
            }
            params.onSuccess?.();
            params.toast.add({
                color: 'success',
                title: params.t('notifications.docxSavedTitle'),
                description: params.t('notifications.docxSavedDescription', {name: getDocumentRefBaseName(outPath) ?? outPath}),
            });
            return true;
        } finally {
            if (isBrowserDocumentRef(outPath)) {
                await documentWorkingCopy.cleanupFile(outPath).catch(() => {});
            }
        }
    } catch (error) {
        params.setError(params.localizeError(error));
        return false;
    }
}
