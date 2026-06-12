import { shouldAutoRequestWorkspace } from '@app/modules/workspace-shell/host/shouldAutoRequestWorkspace';
import type { IWorkspaceHostSignals } from '@app/modules/workspace-shell/host/shouldAutoRequestWorkspace';

export function resolveWorkspaceRequestedState(
    currentRequested: boolean,
    signals: IWorkspaceHostSignals,
) {
    if (currentRequested) {
        return true;
    }

    return shouldAutoRequestWorkspace(signals);
}
