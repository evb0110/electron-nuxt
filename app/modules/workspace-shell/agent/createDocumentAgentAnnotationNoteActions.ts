import type { Ref } from 'vue';
import type { IAnnotationNoteWindowState } from '@app/types/annotationNoteWindow';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/public';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {
    getAgentRawStringInput,
    getAgentStringInput,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    defineAgentActionHandler,
    type IAgentActionHandlerDefinition,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentActionRegistry';

interface IAgentUpdateNoteInput {
    input: Record<string, unknown>;
    markerRect: IAnnotationCommentSummary['markerRect'] | null;
    text: string;
}

interface ICreateDocumentAgentAnnotationNoteActionsOptions {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    findAgentAnnotationComment: (input: Record<string, unknown>) => IAnnotationCommentSummary;
    normalizeAgentAnnotationComment: (comment: IAnnotationCommentSummary) => object;
    isSameAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => boolean;
    handleOpenAnnotationNote: (comment: IAnnotationCommentSummary) => void;
    updateAnnotationNoteText: (stableKey: string, text: string) => void;
    markAnnotationDirty: () => void;
    updateTextMarkupColorWithHistory: (comment: IAnnotationCommentSummary, color: string) => boolean;
}

function parseAgentAnnotationRef(input: Record<string, unknown>) {
    const stableKey = getAgentStringInput(input, 'stableKey');
    const annotationId = getAgentStringInput(input, 'annotationId');
    const id = getAgentStringInput(input, 'id');
    if (stableKey === null && annotationId === null && id === null) {
        throw new Error('Annotation comment was not found. Use evb://document/{tabId}/annotations to get stable keys.');
    }
    return input;
}

function parseAgentUpdateNoteInput(input: Record<string, unknown>): IAgentUpdateNoteInput {
    parseAgentAnnotationRef(input);
    const text = getAgentRawStringInput(input, 'text')
        ?? getAgentRawStringInput(input, 'note')
        ?? getAgentRawStringInput(input, 'noteText');
    if (text === null) {
        throw new Error('annotation.update_note requires input.text.');
    }
    return {
        input,
        markerRect: normalizeMarkerRect(
            input.markerRect as IAnnotationCommentSummary['markerRect'],
        ),
        text,
    };
}

function parseAgentAnnotationColorInput(input: Record<string, unknown>) {
    parseAgentAnnotationRef(input);
    const color = getAgentStringInput(input, 'color');
    if (!color) {
        throw new Error('annotation.update_text_markup_color requires input.color.');
    }
    return {
        input,
        color,
    };
}

function markerRectsEqual(
    left: IAnnotationCommentSummary['markerRect'] | null | undefined,
    right: IAnnotationCommentSummary['markerRect'] | null | undefined,
) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function createDocumentAgentAnnotationNoteActions(
    options: ICreateDocumentAgentAnnotationNoteActionsOptions,
): ReadonlyArray<IAgentActionHandlerDefinition<unknown>> {
    function patchAgentAnnotationCommentMarker(
        comment: IAnnotationCommentSummary,
        inputMarkerRect: IAnnotationCommentSummary['markerRect'] | null,
        text: string,
    ) {
        if (!inputMarkerRect) {
            return;
        }
        let matched = false;
        const nextComments = options.annotationComments.value.map((candidate) => {
            if (
                candidate.stableKey !== comment.stableKey
                && candidate.id !== comment.id
                && (!candidate.annotationId || candidate.annotationId !== comment.annotationId)
            ) {
                return candidate;
            }
            matched = true;
            return {
                ...candidate,
                markerRect: inputMarkerRect,
                text,
                hasNote: true,
            };
        });
        options.annotationComments.value = matched
            ? nextComments
            : [
                ...nextComments,
                {
                    ...comment,
                    markerRect: inputMarkerRect,
                    text,
                    hasNote: true,
                },
            ];
    }

    function findOpenAgentAnnotationNote(comment: IAnnotationCommentSummary) {
        return options.sortedAnnotationNoteWindows.value.find(note =>
            note.comment.stableKey === comment.stableKey
            || options.isSameAnnotationComment(note.comment, comment),
        );
    }

    function updateOpenAgentAnnotationNoteMarker(
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationCommentSummary['markerRect'] | null,
    ) {
        const openNote = findOpenAgentAnnotationNote(comment);
        if (!openNote || !markerRect) {
            return openNote ?? null;
        }

        const previousComment = openNote.comment;
        openNote.comment = {
            ...previousComment,
            markerRect,
        };
        options.annotationComments.value = options.annotationComments.value.map(candidate => (
            candidate.stableKey === previousComment.stableKey
            || options.isSameAnnotationComment(candidate, previousComment)
                ? {
                    ...candidate,
                    markerRect,
                }
                : candidate
        ));
        return openNote;
    }

    function applyAgentAnnotationNoteTextUpdate(
        comment: IAnnotationCommentSummary,
        text: string,
        markerRect: IAnnotationCommentSummary['markerRect'] | null,
    ) {
        const commentForUpdate = markerRect
            ? {
                ...comment,
                markerRect,
                hasNote: text.trim().length > 0 || comment.hasNote === true,
            }
            : comment;
        patchAgentAnnotationCommentMarker(commentForUpdate, markerRect, text);
        const openNote = updateOpenAgentAnnotationNoteMarker(commentForUpdate, markerRect);
        if (openNote) {
            options.updateAnnotationNoteText(openNote.comment.stableKey, text);
            options.markAnnotationDirty();
            return true;
        }
        return options.pdfViewerRef.value?.updateAnnotationComment(commentForUpdate, text) ?? false;
    }

    function registerAgentAnnotationNoteUpdateHistory(
        previousComment: IAnnotationCommentSummary,
        previousText: string,
        previousMarkerRect: IAnnotationCommentSummary['markerRect'] | null,
        nextComment: IAnnotationCommentSummary,
        nextText: string,
        nextMarkerRect: IAnnotationCommentSummary['markerRect'] | null,
    ) {
        if (
            previousText === nextText
            && markerRectsEqual(previousMarkerRect, nextMarkerRect)
        ) {
            return;
        }

        options.pdfViewerRef.value?.registerAnnotationHistoryCommand?.({
            cmd: () => {
                applyAgentAnnotationNoteTextUpdate(nextComment, nextText, nextMarkerRect);
            },
            undo: () => {
                applyAgentAnnotationNoteTextUpdate(previousComment, previousText, previousMarkerRect);
            },
        });
    }

    return [
        defineAgentActionHandler({
            ids: ['annotation.update_note'],
            parse: parseAgentUpdateNoteInput,
            async run(parsedInput: IAgentUpdateNoteInput) {
                const comment = options.findAgentAnnotationComment(parsedInput.input);
                const previousText = comment.text ?? '';
                const previousMarkerRect = comment.markerRect ?? null;
                const commentForUpdate = parsedInput.markerRect
                    ? {
                        ...comment,
                        markerRect: parsedInput.markerRect,
                        hasNote: true,
                    }
                    : comment;
                patchAgentAnnotationCommentMarker(commentForUpdate, parsedInput.markerRect, parsedInput.text);
                options.handleOpenAnnotationNote(commentForUpdate);
                await nextTick();
                const updated = applyAgentAnnotationNoteTextUpdate(
                    commentForUpdate,
                    parsedInput.text,
                    parsedInput.markerRect,
                );
                if (!updated) {
                    throw new Error('Annotation note could not be updated.');
                }
                registerAgentAnnotationNoteUpdateHistory(
                    comment,
                    previousText,
                    previousMarkerRect,
                    {
                        ...commentForUpdate,
                        text: parsedInput.text,
                        markerRect: parsedInput.markerRect ?? comment.markerRect,
                        hasNote: parsedInput.text.trim().length > 0 || comment.hasNote === true,
                    },
                    parsedInput.text,
                    parsedInput.markerRect ?? previousMarkerRect,
                );
                await nextTick();
                patchAgentAnnotationCommentMarker(commentForUpdate, parsedInput.markerRect, parsedInput.text);
                await nextTick();
                return {
                    updated,
                    comment: options.normalizeAgentAnnotationComment({
                        ...commentForUpdate,
                        markerRect: parsedInput.markerRect ?? comment.markerRect,
                        text: parsedInput.text,
                        hasNote: parsedInput.text.trim().length > 0 || comment.hasNote === true,
                    }),
                };
            },
        }),
        defineAgentActionHandler({
            ids: ['annotation.update_text_markup_color'],
            parse: parseAgentAnnotationColorInput,
            async run(parsedInput: ReturnType<typeof parseAgentAnnotationColorInput>) {
                const comment = options.findAgentAnnotationComment(parsedInput.input);
                const updated = options.updateTextMarkupColorWithHistory(comment, parsedInput.color);
                if (!updated) {
                    throw new Error('Text markup annotation color could not be updated.');
                }
                await nextTick();
                return {
                    updated,
                    comment: options.normalizeAgentAnnotationComment({
                        ...comment,
                        color: parsedInput.color,
                        colorEdited: true,
                    }),
                };
            },
        }),
    ];
}
