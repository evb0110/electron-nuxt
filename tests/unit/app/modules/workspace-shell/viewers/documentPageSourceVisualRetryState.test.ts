import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentPageSourceVisualRetryState } from '@app/modules/workspace-shell/viewers/createDocumentPageSourceVisualRetryState';

describe('documentPageSourceVisualRetryState', () => {
    it('does not carry same-page retry exhaustion into the next document generation', () => {
        const state = createDocumentPageSourceVisualRetryState(2);

        expect(state.recordFailure(1)).toBe(true);
        expect(state.recordFailure(1)).toBe(true);
        expect(state.recordFailure(1)).toBe(false);

        state.beginSourceGeneration();

        expect(state.recordFailure(1)).toBe(true);
    });
});
