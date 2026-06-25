import type { Ref } from 'vue';
import type { IAnnotationEditorState } from '@app/types/annotations';
import type { IPdfAppAnnotationHistoryCommand } from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';

interface IPdfjsHistoryCommandParams {
    type?: number;
    overwriteIfSameType?: boolean;
}

type TPdfAnnotationHistoryEntry =
    | {
        source: 'app';
        command: IPdfAppAnnotationHistoryCommand;
    }
    | {
        source: 'pdfjs';
        type: number | null;
    };

const MAX_HISTORY_DEPTH = 128;

export const usePdfAppAnnotationHistory = (options: {
    pdfjsAnnotationState: Ref<IAnnotationEditorState>;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    markModified: () => void;
}) => {
    const undoStack: TPdfAnnotationHistoryEntry[] = [];
    const redoStack: TPdfAnnotationHistoryEntry[] = [];
    const undoDepth = ref(0);
    const redoDepth = ref(0);
    const canUndo = computed(() => undoDepth.value > 0);
    const canRedo = computed(() => redoDepth.value > 0);
    let routedPdfjsHistoryDepth = 0;

    function syncDepths() {
        undoDepth.value = undoStack.length;
        redoDepth.value = redoStack.length;
    }

    function trimStack(stack: TPdfAnnotationHistoryEntry[]) {
        if (stack.length <= MAX_HISTORY_DEPTH) {
            return;
        }
        stack.splice(0, stack.length - MAX_HISTORY_DEPTH);
    }

    function trimHistory() {
        trimStack(undoStack);
        trimStack(redoStack);
    }

    function emitCombinedState() {
        const pdfjsState = options.pdfjsAnnotationState.value;
        options.emitAnnotationState({
            ...pdfjsState,
            hasSomethingToUndo: pdfjsState.hasSomethingToUndo || canUndo.value,
            hasSomethingToRedo: pdfjsState.hasSomethingToRedo || canRedo.value,
            // App-routed PDF.js history is known immediately, while storage dirty
            // detection can lag until the next annotation state event.
            hasAppAnnotationUndoHistory: canUndo.value,
            hasAppAnnotationRedoHistory: canRedo.value,
        });
    }

    function syncPdfjsUndoStateToRoutedHistory() {
        // Routed PDF.js undo/redo can leave the last annotationeditorstateschanged
        // payload stale; sync it so toolbar buttons settle after one click.
        options.pdfjsAnnotationState.value = {
            ...options.pdfjsAnnotationState.value,
            hasSomethingToUndo: canUndo.value,
            hasSomethingToRedo: canRedo.value,
        };
    }

    function registerCommand(command: IPdfAppAnnotationHistoryCommand) {
        undoStack.push({
            source: 'app',
            command,
        });
        redoStack.length = 0;
        trimHistory();
        syncDepths();
        emitCombinedState();
    }

    function registerPdfjsCommand(params?: IPdfjsHistoryCommandParams) {
        const type = typeof params?.type === 'number' && Number.isFinite(params.type)
            ? params.type
            : null;
        const previous = undoStack.at(-1);
        if (
            params?.overwriteIfSameType
            && previous?.source === 'pdfjs'
            && previous.type === type
        ) {
            undoStack[undoStack.length - 1] = {
                source: 'pdfjs',
                type,
            };
        } else {
            undoStack.push({
                source: 'pdfjs',
                type,
            });
        }
        redoStack.length = 0;
        trimHistory();
        syncDepths();
        emitCombinedState();
    }

    function cleanPdfjsCommands(type: number) {
        let index = undoStack.length - 1;
        while (index >= 0) {
            const entry = undoStack[index];
            if (!entry || entry.source !== 'pdfjs' || entry.type !== type) {
                break;
            }
            index -= 1;
        }
        if (index === undoStack.length - 1) {
            return;
        }
        undoStack.splice(index + 1);
        syncDepths();
        emitCombinedState();
    }

    function removeLastPdfjsEntry(stack: TPdfAnnotationHistoryEntry[]) {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
            if (stack[index]?.source === 'pdfjs') {
                return stack.splice(index, 1)[0] ?? null;
            }
        }
        return null;
    }

    function notifyPdfjsUndo() {
        if (isRoutingPdfjsHistory()) {
            return;
        }
        const entry = removeLastPdfjsEntry(undoStack);
        if (!entry) {
            return;
        }
        redoStack.push(entry);
        trimHistory();
        syncDepths();
        emitCombinedState();
    }

    function notifyPdfjsRedo() {
        if (isRoutingPdfjsHistory()) {
            return;
        }
        const entry = removeLastPdfjsEntry(redoStack);
        if (!entry) {
            return;
        }
        undoStack.push(entry);
        trimHistory();
        syncDepths();
        emitCombinedState();
    }

    function withRoutedPdfjsHistory(action: () => void) {
        routedPdfjsHistoryDepth += 1;
        try {
            action();
        } finally {
            routedPdfjsHistoryDepth -= 1;
        }
    }

    function isRoutingPdfjsHistory() {
        return routedPdfjsHistoryDepth > 0;
    }

    function undo(handlers?: { undoPdfjs?: () => void }) {
        const entry = undoStack.at(-1);
        if (!entry) {
            return false;
        }
        if (entry.source === 'pdfjs' && !handlers?.undoPdfjs) {
            return false;
        }
        undoStack.pop();
        redoStack.push(entry);
        trimHistory();
        syncDepths();
        if (entry.source === 'app') {
            entry.command.undo();
        } else {
            withRoutedPdfjsHistory(() => {
                handlers?.undoPdfjs?.();
            });
            syncPdfjsUndoStateToRoutedHistory();
        }
        options.markModified();
        emitCombinedState();
        return true;
    }

    function redo(handlers?: { redoPdfjs?: () => void }) {
        const entry = redoStack.at(-1);
        if (!entry) {
            return false;
        }
        if (entry.source === 'pdfjs' && !handlers?.redoPdfjs) {
            return false;
        }
        redoStack.pop();
        undoStack.push(entry);
        trimHistory();
        syncDepths();
        if (entry.source === 'app') {
            entry.command.cmd();
        } else {
            withRoutedPdfjsHistory(() => {
                handlers?.redoPdfjs?.();
            });
            syncPdfjsUndoStateToRoutedHistory();
        }
        options.markModified();
        emitCombinedState();
        return true;
    }

    function clear() {
        undoStack.length = 0;
        redoStack.length = 0;
        syncDepths();
        emitCombinedState();
    }

    function discardPdfjsCommands() {
        const undoLength = undoStack.length;
        const redoLength = redoStack.length;
        for (let index = undoStack.length - 1; index >= 0; index -= 1) {
            if (undoStack[index]?.source === 'pdfjs') {
                undoStack.splice(index, 1);
            }
        }
        for (let index = redoStack.length - 1; index >= 0; index -= 1) {
            if (redoStack[index]?.source === 'pdfjs') {
                redoStack.splice(index, 1);
            }
        }
        if (undoStack.length === undoLength && redoStack.length === redoLength) {
            return;
        }
        syncDepths();
        emitCombinedState();
    }

    return {
        canUndo,
        canRedo,
        registerCommand,
        registerPdfjsCommand,
        cleanPdfjsCommands,
        notifyPdfjsUndo,
        notifyPdfjsRedo,
        isRoutingPdfjsHistory,
        undo,
        redo,
        clear,
        discardPdfjsCommands,
        emitCombinedState,
    };
};
