// Automation entry point for "mark this text on this page". It resolves the
// request to a DOM range and then hands the work to the shared selection
// markup path, so its result carries the same typed outcome the UI sees.
import type { Ref } from 'vue';
import type { TMarkupSubtype } from '@app/types/annotations';
import type {
    ICreateTextMarkupFromTextOptions,
    ICreateTextMarkupFromTextResult,
    TAgentTextMarkupKind,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type {
    TAnnotationCreationFailureReason,
    TAnnotationCreationOutcome,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import { projectAnnotationCreationOutcome } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/projectAnnotationCreationOutcome';
import { buildRangeFromPageText } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPageText';
import { errorToLogText } from '@app/modules/pdf-viewer/engine/annotation-css-utils/errorToLogText';
import { BrowserLogger } from '@app/utils/browserLogger';

interface ICreateTextMarkupFromTextRunnerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: {value: number};
    ensureAnnotationEditorLayerReady?: ((pageNumber: number) => Promise<void>) | undefined;
    applySelectionMarkup: (
        withComment: boolean,
        range: Range,
        markupSubtype: TMarkupSubtype,
    ) => Promise<TAnnotationCreationOutcome>;
}

/**
 * Keyed by the kind union, so a new markup kind fails to compile until it is
 * mapped here rather than silently falling through to the default below.
 */
const TEXT_MARKUP_SUBTYPES: Record<TAgentTextMarkupKind, TMarkupSubtype> = {
    highlight: 'Highlight',
    underline: 'Underline',
    strikethrough: 'StrikeOut',
    squiggly: 'Squiggly',
};

/**
 * The kind reaches this runner from automation, so an unknown string can arrive
 * at a parameter typed as one of four. An exhaustive switch would return
 * `undefined` for it and write that into a result field declared
 * `TMarkupSubtype`; Highlight is the same default an omitted kind already gets.
 */
function resolveTextMarkupSubtype(markup: TAgentTextMarkupKind | undefined): TMarkupSubtype {
    return (markup === undefined ? undefined : TEXT_MARKUP_SUBTYPES[markup]) ?? 'Highlight';
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.trunc(value))
        : fallback;
}

export function createTextMarkupFromTextRunner(options: ICreateTextMarkupFromTextRunnerOptions) {
    const {
        viewerContainer,
        currentPage,
        numPages,
        ensureAnnotationEditorLayerReady,
        applySelectionMarkup,
    } = options;

    function getPageContainerByNumber(pageNumber: number) {
        return viewerContainer.value?.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        ) ?? null;
    }

    return async function createTextMarkupFromText(
        textMarkupOptions: ICreateTextMarkupFromTextOptions,
    ): Promise<ICreateTextMarkupFromTextResult> {
        const pageNumber = normalizePositiveInteger(textMarkupOptions.pageNumber, currentPage.value);
        const occurrence = normalizePositiveInteger(textMarkupOptions.occurrence, 1);
        const requestedText = textMarkupOptions.text.trim();
        const subtype = resolveTextMarkupSubtype(textMarkupOptions.markup);
        const createResult = (
            created: boolean,
            matchedText: string | null,
            reason?: string,
            failureReason?: TAnnotationCreationFailureReason,
            pendingEditor?: boolean,
        ): ICreateTextMarkupFromTextResult => ({
            created,
            pageNumber,
            requestedText,
            matchedText,
            occurrence,
            subtype,
            ...(reason ? {reason} : {}),
            ...(failureReason ? {failureReason} : {}),
            ...(pendingEditor ? {pendingEditor} : {}),
        });
        const projectOutcome = (
            outcome: TAnnotationCreationOutcome,
            matchedText: string | null,
        ): ICreateTextMarkupFromTextResult => {
            const projection = projectAnnotationCreationOutcome(
                outcome,
                'The document changed before the text markup was created.',
            );
            return createResult(
                projection.created,
                matchedText,
                projection.reason,
                projection.failureReason,
                projection.pendingEditor,
            );
        };

        if (!requestedText) {
            return createResult(false, null, 'Text is required.');
        }

        if (pageNumber > numPages.value) {
            return createResult(false, null, `Page ${pageNumber} is outside the document.`);
        }

        try {
            await ensureAnnotationEditorLayerReady?.(pageNumber);
            await nextTick();
        } catch (error) {
            BrowserLogger.warn('annotations', `Failed to prepare page ${pageNumber} for text markup: ${errorToLogText(error)}`);
        }

        const pageContainer = getPageContainerByNumber(pageNumber);
        if (!pageContainer) {
            return createResult(false, null, `Page ${pageNumber} is not rendered.`, 'page-not-rendered');
        }

        const match = buildRangeFromPageText(pageContainer, {
            text: requestedText,
            occurrence,
            caseSensitive: textMarkupOptions.caseSensitive,
            wholeWord: textMarkupOptions.wholeWord,
        });
        if (!match) {
            return createResult(false, null, `Text was not found on page ${pageNumber}.`);
        }

        const outcome = await applySelectionMarkup(
            textMarkupOptions.withNote === true,
            match.range,
            subtype,
        );
        return projectOutcome(outcome, match.matchedText);
    };
}
