export interface IPdfAppAnnotationHistoryCommand {
    cmd: () => void;
    undo: () => void;
}
