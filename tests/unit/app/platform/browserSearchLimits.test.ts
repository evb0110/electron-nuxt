import {describe, expect, it} from 'vitest';
import {
    validateBrowserSearchPageCount,
    validateBrowserSearchQueryCost,
} from '@app/platform/browser-api/browserSearchLimits';

describe('browser search limits', () => {
    it('rejects query work and page counts above the browser budget', () => {
        expect(() => validateBrowserSearchQueryCost('x'.repeat(16), 1_000_000))
            .toThrow('browser search query cost exceeds');
        expect(() => validateBrowserSearchPageCount(1_000_001))
            .toThrow('browser search page count exceeds');
    });
});
