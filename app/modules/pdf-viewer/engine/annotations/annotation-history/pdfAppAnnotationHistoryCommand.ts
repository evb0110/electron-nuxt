export interface IPdfAppAnnotationHistoryCommand {
    cmd: () => void;
    undo: () => void;
    /** Includes retained checkpoints/closures; unknown commands use 1 KiB. */
    estimatedBytes?: number;
}
