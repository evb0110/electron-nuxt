
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { usePositionedMenu } from '@app/composables/usePositionedMenu';

interface IAnnotationContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

interface IContextMenuDeleteLabels {
    annotation: string;
    delete: string;
    image: string;
    stickyNote: string;
}

const MARKUP_DELETE_SUBTYPES = new Set([
    'highlight',
    'underline',
    'strikeout',
    'squiggly',
]);

function normalizeCommentSubtype(comment: IAnnotationCommentSummary) {
    return (comment.subtype ?? '').trim().toLowerCase();
}

function formatDeleteLabel(label: string, labels: IContextMenuDeleteLabels) {
    return `${labels.delete} ${label}`;
}

function resolveMarkupDeleteLabel(comment: IAnnotationCommentSummary, labels: IContextMenuDeleteLabels) {
    if (comment.text.trim().length > 0 || !MARKUP_DELETE_SUBTYPES.has(normalizeCommentSubtype(comment))) {
        return null;
    }
    return formatDeleteLabel(comment.kindLabel?.trim() || labels.annotation, labels);
}

function resolveDefaultDeleteTargetLabel(comment: IAnnotationCommentSummary, labels: IContextMenuDeleteLabels) {
    const subtype = normalizeCommentSubtype(comment);
    const isExplicitNote = comment.hasNote === true || subtype === 'popup' || subtype === 'text';
    return isExplicitNote ? labels.stickyNote : labels.annotation;
}

function resolveContextMenuDeleteActionLabel(
    comment: IAnnotationCommentSummary | null,
    labels: IContextMenuDeleteLabels,
) {
    if (!comment) {
        return labels.delete;
    }

    const subtype = normalizeCommentSubtype(comment);
    if (subtype === 'stamp') {
        return formatDeleteLabel(labels.image, labels);
    }

    const markupLabel = resolveMarkupDeleteLabel(comment, labels);
    if (markupLabel) {
        return markupLabel;
    }

    return formatDeleteLabel(resolveDefaultDeleteTargetLabel(comment, labels), labels);
}

export const useAnnotationContextMenu = () => {
    const { t } = useTypedI18n();

    function createInitialAnnotationContextMenuState(): IAnnotationContextMenuState {
        return {
            visible: false,
            x: 0,
            y: 0,
            comment: null,
            hasSelection: false,
            selectionText: '',
            pageNumber: null,
            pageX: null,
            pageY: null,
        };
    }
    const {
        menu: annotationContextMenu,
        menuStyle: annotationContextMenuStyle,
        showPositionedMenu,
        resetMenu,
    } = usePositionedMenu<IAnnotationContextMenuState>(
        '.annotation-context-menu',
        createInitialAnnotationContextMenuState,
    );

    const annotationContextMenuCanCopy = computed(() => {
        const text = annotationContextMenu.value.comment?.text?.trim();
        return Boolean(text);
    });

    const annotationContextMenuCanCopySelection = computed(() => (
        annotationContextMenu.value.selectionText.trim().length > 0
    ));

    const annotationContextMenuCanCreateFree = computed(() => (
        Number.isFinite(annotationContextMenu.value.pageNumber)
        && Number.isFinite(annotationContextMenu.value.pageX)
        && Number.isFinite(annotationContextMenu.value.pageY)
    ));

    const annotationContextMenuCanInsertImage = computed(() => (
        Number.isFinite(annotationContextMenu.value.pageNumber)
        && Number.isFinite(annotationContextMenu.value.pageX)
        && Number.isFinite(annotationContextMenu.value.pageY)
    ));

    const annotationContextMenuIsImage = computed(() => (
        (annotationContextMenu.value.comment?.subtype ?? '').trim().toLowerCase() === 'stamp'
    ));

    const contextMenuAnnotationLabel = computed(() => {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return t('annotations.annotationLabel');
        }
        if ((comment.subtype ?? '').trim().toLowerCase() === 'stamp') {
            return t('annotations.imageLabel');
        }
        return comment.kindLabel ?? comment.subtype ?? t('annotations.annotationLabel');
    });

    const contextMenuDeleteActionLabel = computed(() => {
        return resolveContextMenuDeleteActionLabel(annotationContextMenu.value.comment, {
            annotation: t('annotations.annotationLabel'),
            delete: t('annotations.delete'),
            image: t('annotations.imageLabel'),
            stickyNote: t('annotations.stickyNoteLabel'),
        });
    });

    function closeAnnotationContextMenu() {
        if (!annotationContextMenu.value.visible) {
            return;
        }
        resetMenu();
    }

    function showAnnotationContextMenu(payload: {
        comment: IAnnotationCommentSummary | null;
        clientX: number;
        clientY: number;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }) {
        const hasComment = Boolean(payload.comment);
        const hasSelection = payload.hasSelection;
        const fallbackWidth = 360;
        const markupSectionHeight = hasSelection ? 200 : 0;
        const estimatedHeight = (hasComment ? 258 : 0) + markupSectionHeight + 252;

        showPositionedMenu({
            x: payload.clientX,
            y: payload.clientY,
            fallbackWidth,
            fallbackHeight: estimatedHeight,
            buildState: position => ({
                visible: true,
                x: position.x,
                y: position.y,
                comment: payload.comment,
                hasSelection: payload.hasSelection,
                selectionText: payload.selectionText,
                pageNumber: payload.pageNumber,
                pageX: payload.pageX,
                pageY: payload.pageY,
            }),
        });
    }

    return {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        annotationContextMenuCanInsertImage,
        annotationContextMenuIsImage,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
    };
};
