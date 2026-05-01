
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

export const useAnnotationContextMenu = () => {
    const { t } = useTypedI18n();

    const createInitialAnnotationContextMenuState = (): IAnnotationContextMenuState => ({
        visible: false,
        x: 0,
        y: 0,
        comment: null,
        hasSelection: false,
        selectionText: '',
        pageNumber: null,
        pageX: null,
        pageY: null,
    });
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
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return t('annotations.delete');
        }

        const subtype = (comment.subtype ?? '').trim().toLowerCase();
        if (subtype === 'stamp') {
            return `${t('annotations.delete')} ${t('annotations.imageLabel')}`;
        }
        const kind = comment.kindLabel?.trim() ?? '';
        const isMarkup = (
            subtype === 'highlight'
            || subtype === 'underline'
            || subtype === 'strikeout'
            || subtype === 'squiggly'
        );
        const hasNoteText = comment.text.trim().length > 0;
        if (!hasNoteText && isMarkup) {
            if (kind.length > 0) {
                return `${t('annotations.delete')} ${kind}`;
            }
            return `${t('annotations.delete')} ${t('annotations.annotationLabel')}`;
        }

        const isExplicitNote = comment.hasNote === true || subtype === 'popup' || subtype === 'text';
        if (isExplicitNote) {
            return `${t('annotations.delete')} ${t('annotations.stickyNoteLabel')}`;
        }
        return `${t('annotations.delete')} ${t('annotations.annotationLabel')}`;
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
