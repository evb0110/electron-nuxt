import type { TWorkspaceUndoSource } from '@app/types/workspaceUndoSource';
import type {IWorkspaceCommandRegistration} from '@app/types/workspaceCommand';

interface IWorkspaceCommand {
    readonly source: TWorkspaceUndoSource;
    readonly checkpoint: number;
    readonly inverse: 'undo';
    readonly estimatedBytes: number;
    canUndo(): boolean;
    canRedo(): boolean;
    undo(): Promise<boolean>;
    cmd(): Promise<boolean>;
}

const MAX_WORKSPACE_COMMAND_DEPTH = 128;
const MAX_WORKSPACE_COMMAND_BYTES = 32 * 1024 * 1024;
const DEFAULT_WORKSPACE_COMMAND_BYTES = 1024;

export const useWorkspaceCommandLedger = () => {
    // This is the single workspace command stack. File checkpoints, metadata
    // inverse commands and annotation commands are represented identically;
    // the source is diagnostic metadata, not a routing authority.
    const commands = shallowRef<IWorkspaceCommand[]>([]);
    const commandIndex = ref(-1);
    let isExecutingCommand = false;

    function createCommand(input: IWorkspaceCommandRegistration): IWorkspaceCommand {
        return {
            source: input.source,
            checkpoint: commands.value.length,
            inverse: 'undo',
            estimatedBytes: Math.max(0, input.estimatedBytes ?? DEFAULT_WORKSPACE_COMMAND_BYTES),
            canUndo: input.canUndo ?? (() => true),
            canRedo: input.canRedo ?? (() => true),
            undo: async () => (await input.undo()) === true,
            cmd: async () => (await input.cmd()) === true,
        };
    }

    function recordEntry(command: IWorkspaceCommand) {
        if (isExecutingCommand) {
            return;
        }
        const nextCommands = commands.value.slice(0, commandIndex.value + 1);
        nextCommands.push(command);
        let retainedBytes = nextCommands.reduce((total, entry) => total + entry.estimatedBytes, 0);
        while (nextCommands.length > MAX_WORKSPACE_COMMAND_DEPTH || retainedBytes > MAX_WORKSPACE_COMMAND_BYTES) {
            const removed = nextCommands.shift();
            retainedBytes -= removed?.estimatedBytes ?? 0;
        }
        commands.value = nextCommands;
        commandIndex.value = commands.value.length - 1;
    }

    function registerCommand(input: IWorkspaceCommandRegistration) {
        recordEntry(createCommand(input));
    }

    function pruneEntries(source: TWorkspaceUndoSource) {
        if (commands.value.length === 0) {
            return;
        }

        let removedAppliedCommands = 0;
        const nextCommands = commands.value.filter((command, index) => {
            const shouldRemove = command.source === source;
            if (shouldRemove && index <= commandIndex.value) {
                removedAppliedCommands += 1;
            }
            return !shouldRemove;
        });

        commands.value = nextCommands;
        if (nextCommands.length === 0) {
            commandIndex.value = -1;
            return;
        }

        commandIndex.value = Math.min(
            nextCommands.length - 1,
            Math.max(-1, commandIndex.value - removedAppliedCommands),
        );
    }

    function resetTimeline() {
        commands.value = [];
        commandIndex.value = -1;
    }

    function resetSource(source?: TWorkspaceUndoSource) {
        if (source === undefined) {
            resetTimeline();
            return;
        }
        pruneEntries(source);
    }

    const canUndoTimeline = computed(() => (
        commands.value[commandIndex.value]?.canUndo() === true
    ));
    const canRedoTimeline = computed(
        () => commands.value[commandIndex.value + 1]?.canRedo() === true,
    );
    const nextUndoSource = computed<TWorkspaceUndoSource | null>(
        () => commands.value[commandIndex.value]?.source ?? null,
    );
    const nextRedoSource = computed<TWorkspaceUndoSource | null>(
        () => commands.value[commandIndex.value + 1]?.source ?? null,
    );

    async function undoTimeline() {
        const command = commands.value[commandIndex.value];
        if (!command || !command.canUndo() || isExecutingCommand) {
            return false;
        }
        isExecutingCommand = true;
        try {
            const didUndo = await command.undo();
            if (!didUndo) {
                commands.value = commands.value.filter(candidate => candidate !== command);
                commandIndex.value = Math.min(commandIndex.value, commands.value.length - 1);
                return false;
            }
            commandIndex.value -= 1;
            return true;
        } finally {
            isExecutingCommand = false;
        }
    }

    async function redoTimeline() {
        const command = commands.value[commandIndex.value + 1];
        if (!command || !command.canRedo() || isExecutingCommand) {
            return false;
        }
        isExecutingCommand = true;
        try {
            const didRedo = await command.cmd();
            if (!didRedo) {
                commands.value = commands.value.filter(candidate => candidate !== command);
                return false;
            }
            commandIndex.value += 1;
            return true;
        } finally {
            isExecutingCommand = false;
        }
    }

    return {
        canUndoTimeline,
        canRedoTimeline,
        nextUndoSource,
        nextRedoSource,
        registerCommand,
        resetSource,
        resetTimeline,
        undoTimeline,
        redoTimeline,
    };
};
