import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/expose/isWorkspaceExpose';
import { requiredWorkspaceExposeMethods } from '@app/modules/workspace-shell/expose/requiredWorkspaceExposeMethods';

function createWorkspaceCandidate(overrides: Record<string, unknown> = {}) {
    const candidate: Record<string, unknown> = {hasPdf: false};

    for (const methodName of requiredWorkspaceExposeMethods) {
        candidate[methodName] = vi.fn();
    }

    return {
        ...candidate,
        ...overrides,
    };
}

describe('workspace expose contract', () => {
    it('accepts values that match the workspace expose contract', () => {
        expect(isWorkspaceExpose(createWorkspaceCandidate())).toBe(true);
    });

    it('rejects values without hasPdf', () => {
        const candidate = createWorkspaceCandidate();
        delete candidate.hasPdf;

        expect(isWorkspaceExpose(candidate)).toBe(false);
    });

    it('rejects values with missing methods', () => {
        const candidate = createWorkspaceCandidate();
        delete candidate.handleOpenFileWithResult;

        expect(isWorkspaceExpose(candidate)).toBe(false);
    });

    it('rejects values where a method is not a function', () => {
        expect(isWorkspaceExpose(createWorkspaceCandidate({ handleSave: true }))).toBe(false);
    });
});
