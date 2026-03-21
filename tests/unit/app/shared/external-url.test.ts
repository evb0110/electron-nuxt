import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    normalizeAllowedExternalUrl,
    sanitizeAllowedExternalUrl,
} from '@contracts/external-url';

describe('external URL helpers', () => {
    it('normalizes allowed external URLs', () => {
        expect(normalizeAllowedExternalUrl(' https://example.com/docs ')).toBe('https://example.com/docs');
        expect(normalizeAllowedExternalUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
    });

    it('rejects unsupported external URL protocols', () => {
        expect(normalizeAllowedExternalUrl('javascript:alert(1)')).toBeNull();
        expect(() => sanitizeAllowedExternalUrl('file:///tmp/test.pdf')).toThrow(
            'Unsupported external URL protocol: file:',
        );
    });
});
