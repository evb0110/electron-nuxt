import type { Ref } from 'vue';
import type { IAnnotationEditorState } from '@app/types/annotations';
import type {AnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    IPdfAppAnnotationHistoryCommand,
    TRegisterAnnotationHistoryFailureRollback,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {
    buildAnnotationHistoryReplayFailure,
    isAnnotationHistoryPoisoningError,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {toCompatibleAnnotationEditorState} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import type { IPdfjsAnnotationEditorState } from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';
import {BrowserLogger} from '@app/utils/browserLogger';

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
        notifyAfterReplay('mark the document modified', options.markModified);
        notifyAfterReplay('emit annotation history state', emitCombinedState);
        if (replayEffect) {
            notifyAfterReplay('synchronize annotation projections', replayEffect);
        }
    }

    function notifyAfterReplay(message: string, notify: () => void) {
        try {
            notify();
        } catch (error) {
            try {
                BrowserLogger.warn('annotations', `Failed to ${message} after replay`, error);
            } catch {
                // Diagnostics must not turn a successful replay into a failure.
            }
        }
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
                undo: () => replayWorkspaceCommand(command.undo),
                cmd: () => replayWorkspaceCommand(command.cmd),
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

    function forgetCommands(ids: ReadonlySet<AnnotationId>) {
        const keep = (command: IPdfAppAnnotationHistoryCommand) => (
            !command.annotationIds?.some(id => ids.has(id))
        );
        transactionCommands = transactionCommands.filter(keep);
        if (workspaceCommandSink) {
            workspaceCommandSink.reset('annotation');
        } else {
            undoStack.splice(0, undoStack.length, ...undoStack.filter(keep));
            redoStack.splice(0, redoStack.length, ...redoStack.filter(keep));
        }
        syncDepths();
        annotationHistoryResetVersion.value += 1;
        emitCombinedState();
    }

    function replayTransactionAtomically(
        commands: readonly IPdfAppAnnotationHistoryCommand[],
        apply: (
            command: IPdfAppAnnotationHistoryCommand,
            registerFailureRollback: TRegisterAnnotationHistoryFailureRollback,
        ) => void,
        compensate: (command: IPdfAppAnnotationHistoryCommand) => void,
    ) {
        const applied: IPdfAppAnnotationHistoryCommand[] = [];
        for (const command of commands) {
            const failureRollbacks: Array<() => void> = [];
            try {
                apply(command, rollback => failureRollbacks.push(rollback));
                applied.push(command);
            } catch (error) {
                throw buildAnnotationHistoryReplayFailure(error, [
                    ...failureRollbacks.reverse(),
                    ...applied.reverse().map(child => () => compensate(child)),
                ]);
            }
        }
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
            cmd: (registerFailureRollback) => {
                replayTransactionAtomically(
                    commands,
                    (command, register) => command.cmd(register),
                    command => command.undo(),
                );
                registerFailureRollback?.(() => replayTransactionAtomically(
                    [...commands].reverse(),
                    (command, register) => command.undo(register),
                    command => command.cmd(),
                ));
            },
            undo: (registerFailureRollback) => {
                replayTransactionAtomically(
                    [...commands].reverse(),
                    (command, register) => command.undo(register),
                    command => command.cmd(),
                );
                registerFailureRollback?.(() => replayTransactionAtomically(
                    commands,
                    (command, register) => command.cmd(register),
                    command => command.undo(),
                ));
            },
            estimatedBytes: commands.reduce((total, command) => (
                total + Math.max(0, command.estimatedBytes ?? DEFAULT_COMMAND_BYTES)
            ), 0),
            annotationIds: Array.from(new Set(commands.flatMap(command => command.annotationIds ?? []))),
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

    function throwReplayFailure(originalError: unknown, rollbacks: ReadonlyArray<() => void>): never {
        const failure = buildAnnotationHistoryReplayFailure(originalError, rollbacks);
        if (isAnnotationHistoryPoisoningError(failure)) {
            poisonHistory();
        }
        throw failure;
    }

    function poisonHistory() {
        undoStack.length = 0;
        redoStack.length = 0;
        transactionCommands = [];
        syncDepths();
        annotationHistoryResetVersion.value += 1;
        ignoreFailure(() => workspaceCommandSink?.reset('annotation'));
        ignoreFailure(emitCombinedState);
    }

    function ignoreFailure(action: () => void) {
        try {
            action();
        } catch {
            // The compensation diagnostic remains the primary failure.
        }
    }

    function replayWorkspaceCommand(
        apply: IPdfAppAnnotationHistoryCommand['cmd'],
    ) {
        const rollbacks: Array<() => void> = [];
        try {
            withRoutedPdfjsHistory(() => apply(rollback => rollbacks.unshift(rollback)));
            finishReplay();
            return true;
        } catch (error) {
            return throwReplayFailure(error, rollbacks);
        }
    }

    function replayLocalCommand(
        apply: IPdfAppAnnotationHistoryCommand['cmd'],
        move: () => void,
    ) {
        const undoBefore = [...undoStack];
        const redoBefore = [...redoStack];
        const rollbacks: Array<() => void> = [];
        try {
            withRoutedPdfjsHistory(() => apply(rollback => rollbacks.unshift(rollback)));
            rollbacks.unshift(() => {
                undoStack.splice(0, undoStack.length, ...undoBefore);
                redoStack.splice(0, redoStack.length, ...redoBefore);
                syncDepths();
                emitCombinedState();
            });
            move();
            trimHistory();
            syncDepths();
            finishReplay();
            return true;
        } catch (error) {
            return throwReplayFailure(error, rollbacks);
        }
    }

    function undo() {
        const command = undoStack.at(-1);
        if (!command) {
            return false;
        }
        return replayLocalCommand(command.undo, () => {
            undoStack.pop();
            redoStack.push(command);
        });
    }

    function redo() {
        const command = redoStack.at(-1);
        if (!command) {
            return false;
        }
        return replayLocalCommand(command.cmd, () => {
            redoStack.pop();
            undoStack.push(command);
        });
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
        forgetCommands,
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
