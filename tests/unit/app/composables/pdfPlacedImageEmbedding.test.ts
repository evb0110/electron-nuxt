import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePlacedImageEmbedMode } from '@app/composables/pdf/pdfPlacedImageEmbedding';

describe('resolvePlacedImageEmbedMode', () => {
    it('preserves png source bytes for direct PDF embedding', () => {
        expect(resolvePlacedImageEmbedMode('image/png')).toBe('png');
    });

    it('preserves jpeg source bytes for direct PDF embedding', () => {
        expect(resolvePlacedImageEmbedMode('image/jpeg')).toBe('jpg');
    });

    it('falls back to rasterization for non-native PDF image formats', () => {
        expect(resolvePlacedImageEmbedMode('image/webp')).toBe('rasterize-png');
        expect(resolvePlacedImageEmbedMode('image/svg+xml')).toBe('rasterize-png');
        expect(resolvePlacedImageEmbedMode(undefined)).toBe('rasterize-png');
    });
});
