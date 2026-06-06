export interface IWorkspaceHasPdfState {
    hasPdf: boolean | { value: boolean };
    getToolbarSnapshot?: () => {
        canSave: boolean;
        canRepairSave?: boolean;
    };
}

export function workspaceHasPdf(workspace: IWorkspaceHasPdfState | null | undefined) {
    if (!workspace) {
        return false;
    }
    return typeof workspace.hasPdf === 'boolean' ? workspace.hasPdf : workspace.hasPdf.value;
}
