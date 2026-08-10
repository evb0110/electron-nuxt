import type { WebContents } from 'electron';
import { extname } from 'path';
import type { IOcrCancelResult } from '@contracts/electronApiOcr';
import type { IPlatformMainSenderContext } from '@contracts/platformFeature';
import {AVAILABLE_OCR_LANGUAGES} from '@electron/ocr/availableLanguages';
import {
    buildOcrErrorEnvelope,
    mapStartFailureCode,
    OcrPayloadValidationError,
    toOcrErrorEnvelope,
    validateCancelRequestId,
    validateCreateSearchablePdfPayload,
} from '@electron/ocr/contracts';
import {
    handleOcrAcknowledgeResultFile,
    handleOcrCancel,
    handleOcrCreateSearchablePdfAsync,
} from '@electron/ocr/jobManager';
import { createLogger } from '@electron/utils/createLogger';
import {
    resolveDocumentOcrAvailability,
    resolveDocumentOcrPage,
    resolveDocumentTextCatalogSnapshot,
} from '@electron/ocr/documentTextCatalog';
import { getOcrLanguageModelStates } from '@electron/ocr/languageModels';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import {requireManagedWorkingCopyPath} from '@electron/file-access/workingCopyCreation';
import {
    ensureWorkingCopyMaterialized,
    WorkingCopyMaterializationError,
} from '@electron/file-access/workingCopyMaterialization';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('ocr-ipc');
type TOcrOperationContext = IPlatformMainSenderContext<WebContents>;

export async function handleOcrGetLanguages() {
    const modelStates = new Map(
        (await getOcrLanguageModelStates()).map(item => [
            item.code,
            item.state,
        ]),
    );
    return AVAILABLE_OCR_LANGUAGES.map(language => ({
        ...language,
        modelState: modelStates.get(language.code) ?? 'missing',
    }));
}

export async function handleResolveDocumentTextCatalog(
    context: TOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount?: number,
) {
    const resolvedPath = await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
    return resolveDocumentTextCatalogSnapshot(resolvedPath, documentRevision, pageCount);
}

export async function handleResolveDocumentOcrAvailability(
    context: TOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
) {
    const resolvedPath = await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
    return resolveDocumentOcrAvailability(resolvedPath, documentRevision);
}

export async function handleResolveDocumentOcrPage(
    context: TOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageNumber: number,
) {
    const resolvedPath = await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
    return resolveDocumentOcrPage(resolvedPath, documentRevision, pageNumber);
}

async function validateOcrSourcePdfPath(sourcePdfPath: string, senderWebContentsId: number) {
    let managedSourcePdfPath: string;
    try {
        managedSourcePdfPath = await requireManagedWorkingCopyPath(sourcePdfPath, senderWebContentsId);
    } catch (error) {
        throw new OcrPayloadValidationError(`sourcePdfPath is not a managed working copy: ${getErrorMessage(error)}`);
    }
    const resolvedPath = await resolveAllowedReadPath(managedSourcePdfPath);
    if (!resolvedPath) {
        throw new OcrPayloadValidationError('sourcePdfPath must be inside the temporary working directory');
    }

    if (extname(resolvedPath).toLowerCase() !== '.pdf') {
        throw new OcrPayloadValidationError('sourcePdfPath must point to a PDF file');
    }

    return resolvedPath;
}

async function validateOcrPersistenceSourcePdfPath(sourcePdfPath: string, senderWebContentsId: number) {
    let materializedSourcePdfPath: string;
    try {
        materializedSourcePdfPath = (
            await ensureWorkingCopyMaterialized(sourcePdfPath, {
                ownerWebContentsId: senderWebContentsId,
                reason: 'ocr-persist',
            })
        ).physicalWorkingCopyPath;
    } catch (error) {
        if (error instanceof WorkingCopyMaterializationError) {
            throw error;
        }
        throw new OcrPayloadValidationError(`sourcePdfPath is not a managed working copy: ${getErrorMessage(error)}`);
    }
    return validateOcrSourcePdfPath(materializedSourcePdfPath, senderWebContentsId);
}

export async function handleOcrCreateSearchablePdf(
    context: TOcrOperationContext,
    sourcePdfPathPayload: unknown,
    pagesPayload: unknown,
    requestIdPayload: unknown,
    renderDpiOrOptionsPayload?: unknown,
): Promise<{
    started: boolean;
    jobId: string;
    error?: string;
    errorEnvelope?: ReturnType<typeof buildOcrErrorEnvelope>;
}> {
    let jobId = typeof requestIdPayload === 'string' ? requestIdPayload.trim() : '';

    try {
        const payload = validateCreateSearchablePdfPayload(
            sourcePdfPathPayload,
            pagesPayload,
            requestIdPayload,
            renderDpiOrOptionsPayload,
        );

        jobId = payload.requestId;
        const validatedSourcePdfPath = await validateOcrPersistenceSourcePdfPath(
            payload.sourcePdfPath,
            context.senderId,
        );
        const result = await handleOcrCreateSearchablePdfAsync(
            context,
            validatedSourcePdfPath,
            payload.pages,
            payload.requestId,
            payload.options,
        );

        if (!result.started && result.error) {
            const {
                errorCode,
                ...publicResult
            } = result;
            return {
                ...publicResult,
                errorEnvelope: buildOcrErrorEnvelope(
                    errorCode ?? mapStartFailureCode(result.error),
                    result.error,
                    {retryable: true},
                ),
            };
        }

        return result;
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error, 'OCR_INTERNAL_ERROR', true);
        log.warn(`ocr:createSearchablePdf rejected: ${envelope.message}`);
        return {
            started: false,
            jobId,
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}

export function handleOcrCancelValidated(
    context: TOcrOperationContext,
    requestIdPayload: unknown,
): IOcrCancelResult {
    try {
        return handleOcrCancel(context, validateCancelRequestId(requestIdPayload));
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:cancel rejected: ${envelope.message}`);
        return {
            canceled: false,
            reason: 'invalid-request',
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}

export async function handleOcrAcknowledgeResultFileValidated(
    context: TOcrOperationContext,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
) {
    try {
        return await handleOcrAcknowledgeResultFile(
            context,
            requestIdPayload,
            pdfPathPayload,
        );
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:ackResultFile rejected: ${envelope.message}`);
        return {
            cleaned: false,
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}
