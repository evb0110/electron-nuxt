import type { Ref } from 'vue';
import type { IAnnotationEditorState } from '@app/types/annotations';
import type { IPdfAppAnnotationHistoryCommand } from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {toCompatibleAnnotationEditorState} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import type { IPdfjsAnnotationEditorState } from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';

const MAX_HISTORY_DEPTH = 128;
// File checkpoints use the other 16 MiB half of the app-wide 32 MiB undo cap.
const MAX_ANNOTATION_HISTORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMMAND_BYTES = 1024;

export const usePdfAppAnnotationHistory = (options: {
    pdfjsAnnotationState: Ref<IPdfjsAnnotationEditorState>;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    markModified: () => void;
}) => {
    const undoStack: IPdfAppAnnotationHistoryCommand[] = [];
    const redoStack: IPdfAppAnnotationHistoryCommand[] = [];
    const undoDepth = ref(0);
    const redoDepth = ref(0);
    const annotationHistoryMutationVersion = ref(0);
    const annotationHistoryResetVersion = ref(0);
    const canUndo = computed(() => undoDepth.value > 0);
    const canRedo = computed(() => redoDepth.value > 0);
    let routedPdfjsHistoryDepth = 0;
    let transactionDepth = 0;
    let transactionCommands: IPdfAppAnnotationHistoryCommand[] = [];
    let workspaceCommandSink: IWorkspaceCommandSink | null = null;
    let replayEffect: (() => void) | null = null;

    function setReplayEffect(effect: (() => void) | null) {
        replayEffect = effect;
    }

    function finishReplay() {
        options.markModified();
        emitCombinedState();
        replayEffect?.();
    }

    function setWorkspaceCommandSink(sink: IWorkspaceCommandSink | null) {
        workspaceCommandSink = sink;
        undoStack.length = 0;
        redoStack.length = 0;
        syncDepths();
        emitCombinedState();
    }

    function syncDepths() {
        undoDepth.value = undoStack.length;
        redoDepth.value = redoStack.length;
    }

    function trimStack(stack: IPdfAppAnnotationHistoryCommand[]) {
        let retainedBytes = stack.reduce((total, command) => (
            total + Math.max(0, command.estimatedBytes ?? DEFAULT_COMMAND_BYTES)
        ), 0);
        while (stack.length > MAX_HISTORY_DEPTH || retainedBytes > MAX_ANNOTATION_HISTORY_BYTES) {
            const removed = stack.shift();
            retainedBytes -= Math.max(0, removed?.estimatedBytes ?? DEFAULT_COMMAND_BYTES);
        }
    }

    function trimHistory() {
        trimStack(undoStack);
        trimStack(redoStack);
    }

    function emitCombinedState() {
        options.emitAnnotationState(toCompatibleAnnotationEditorState(
            options.pdfjsAnnotationState.value,
            {
                canUndo: canUndo.value,
                canRedo: canRedo.value,
            },
        ));
    }

    function pushCommand(command: IPdfAppAnnotationHistoryCommand) {
        if (workspaceCommandSink) {
            workspaceCommandSink.register({
                source: 'annotation',
                estimatedBytes: Math.max(0, command.estimatedBytes ?? DEFAULT_COMMAND_BYTES),
                undo: () => {
                    withRoutedPdfjsHistory(command.undo);
                    finishReplay();
                    return true;
                },
                cmd: () => {
                    withRoutedPdfjsHistory(command.cmd);
                    finishReplay();
                    return true;
                },
            });
            annotationHistoryMutationVersion.value += 1;
            emitCombinedState();
            return;
        }
        undoStack.push(command);
        redoStack.length = 0;
        trimHistory();
        syncDepths();
        annotationHistoryMutationVersion.value += 1;
        emitCombinedState();
    }

    function registerCommand(command: IPdfAppAnnotationHistoryCommand) {
        if (transactionDepth > 0) {
            transactionCommands.push(command);
            return;
        }
        pushCommand(command);
    }

    function finishTransaction() {
        transactionDepth -= 1;
        if (transactionDepth > 0) {
            return;
        }
        const commands = transactionCommands;
        transactionCommands = [];
        if (commands.length === 0) {
            return;
        }
        pushCommand({
            cmd: () => commands.forEach(command => command.cmd()),
            undo: () => [...commands].reverse().forEach(command => command.undo()),
            estimatedBytes: commands.reduce((total, command) => (
                total + Math.max(0, command.estimatedBytes ?? DEFAULT_COMMAND_BYTES)
            ), 0),
        });
    }

    function runTransaction<T>(action: () => T): T {
        transactionDepth += 1;
        try {
            const result = action();
            if (result instanceof Promise) {
                return result.finally(finishTransaction) as T;
            }
            finishTransaction();
            return result;
        } catch (error) {
            finishTransaction();
            throw error;
        }
    }

    function registerExecutorCommand(command: IPdfAppAnnotationHistoryCommand) {
        registerCommand(command);
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

    function undo() {
        const command = undoStack.at(-1);
        if (!command) {
            return false;
        }
        undoStack.pop();
        redoStack.push(command);
        trimHistory();
        syncDepths();
        withRoutedPdfjsHistory(command.undo);
        finishReplay();
        return true;
    }

    function redo() {
        const command = redoStack.at(-1);
        if (!command) {
            return false;
        }
        redoStack.pop();
        undoStack.push(command);
        trimHistory();
        syncDepths();
        withRoutedPdfjsHistory(command.cmd);
        finishReplay();
        return true;
    }

    function clear() {
        undoStack.length = 0;
        redoStack.length = 0;
        syncDepths();
        annotationHistoryResetVersion.value += 1;
        workspaceCommandSink?.reset('annotation');
        emitCombinedState();
    }

    return {
        annotationHistoryMutationVersion,
        annotationHistoryResetVersion,
        canUndo,
        canRedo,
        registerCommand,
        registerExecutorCommand,
        runTransaction,
        isRoutingPdfjsHistory,
        undo,
        redo,
        clear,
        emitCombinedState,
        setWorkspaceCommandSink,
        setReplayEffect,
    };
};
