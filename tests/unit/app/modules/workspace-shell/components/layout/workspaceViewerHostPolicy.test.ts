import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldKeepWorkspaceDocumentLayoutVisible } from '@app/modules/workspace-shell/host/shouldKeepWorkspaceDocumentLayoutVisible';

describe('workspace viewer host layout policy', () => {
    it('keeps the inactive document chassis measurable behind a host-owned placeholder', () => {
        expect(shouldKeepWorkspaceDocumentLayoutVisible({
            hasDocument: false,
            keepDocumentLayoutMounted: true,
        })).toBe(true);
    });

    it('does not expose an unused document layout without an owner', () => {
        expect(shouldKeepWorkspaceDocumentLayoutVisible({
            hasDocument: false,
            keepDocumentLayoutMounted: false,
        })).toBe(false);
    });

    it('always exposes a committed document', () => {
        expect(shouldKeepWorkspaceDocumentLayoutVisible({
            hasDocument: true,
            keepDocumentLayoutMounted: false,
        })).toBe(true);
    });
});
