import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDocumentOpenRunResult } from '@app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen';

describe('deferredWorkspaceHostDocumentOpen', () => {
    it('commits document opens only after a terminal state is reached', () => {
        expect(resolveDocumentOpenRunResult('opened', true)).toBe('opened');
        expect(resolveDocumentOpenRunResult('opened', false)).toBe(false);
        expect(resolveDocumentOpenRunResult(false, true)).toBe(false);
    });
});
