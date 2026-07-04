export interface IWorkspaceHasPdfState {
    hasPdf: boolean | { value: boolean };
    getToolbarSnapshot?: () => {
        canPrint?: boolean;
        canSave: boolean;
        canRepairSave?: boolean;
        canOptimizePdf?: boolean;
    };
}

export function workspaceHasPdf(workspace: IWorkspaceHasPdfState | null | undefined) {
    if (!workspace) {
        return false;
    }
    return typeof workspace.hasPdf === 'boolean' ? workspace.hasPdf : workspace.hasPdf.value;
}
