import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { isRecord } from '@contracts/runtimeGuards';
import { requiredWorkspaceExposeMethods } from '@app/modules/workspace-shell/expose/requiredWorkspaceExposeMethods';

function isHasPdfField(value: unknown): value is IWorkspaceExpose['hasPdf'] {
    if (typeof value === 'boolean') {
        return true;
    }
    return isRecord(value) && typeof value.value === 'boolean';
}

export function isWorkspaceExpose(value: unknown): value is IWorkspaceExpose {
    if (!isRecord(value)) {
        return false;
    }

    if (!isHasPdfField(value.hasPdf)) {
        return false;
    }

    return requiredWorkspaceExposeMethods.every(methodName => typeof value[methodName] === 'function');
}
