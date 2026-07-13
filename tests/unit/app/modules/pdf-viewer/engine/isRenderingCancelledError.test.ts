import {
    describe,
    expect,
    it,
} from 'vitest';
import { isRenderingCancelledError } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/isRenderingCancelledError';

describe('isRenderingCancelledError', () => {
    it.each([
        'AbortError',
        'AbortException',
        'RenderingCancelledException',
    ])('recognizes %s as expected render cancellation', (name) => {
        expect(isRenderingCancelledError(Object.assign(new Error('cancelled'), {name}))).toBe(true);
    });

    it('does not classify an ordinary render failure as cancellation', () => {
        expect(isRenderingCancelledError(new Error('canvas allocation failed'))).toBe(false);
    });
});
