import type {TWorkspaceUndoSource} from '@app/types/workspaceUndoSource';

export interface IWorkspaceCommandRegistration {
    source: TWorkspaceUndoSource;
    undo: () => Promise<boolean> | boolean;
    cmd: () => Promise<boolean> | boolean;
    canUndo?: (() => boolean) | undefined;
    canRedo?: (() => boolean) | undefined;
    estimatedBytes?: number;
}

export interface IWorkspaceCommandSink {
    register: (command: IWorkspaceCommandRegistration) => void;
    reset: (source?: TWorkspaceUndoSource) => void;
}
