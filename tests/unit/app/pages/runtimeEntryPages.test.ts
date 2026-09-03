// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import ElectronPage from '@app/pages/electron.vue';
import MobileReaderProofPage from '@app/pages/mobile-reader-proof.vue';

describe('runtime entry pages', () => {
    it('compile into Vue components for their dedicated runtime routes', () => {
        expect(ElectronPage).toBeDefined();
        expect(MobileReaderProofPage).toBeDefined();
    });
});
