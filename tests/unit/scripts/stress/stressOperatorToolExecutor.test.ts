import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    clampZoomRegion,
    mapXdotoolKey,
    parseKeyChord,
} from '@scripts/stress/stressOperatorToolExecutor';

const VIEWPORT = {
    width: 1280,
    height: 800,
};

describe('clampZoomRegion', () => {
    it('keeps an in-bounds region and normalises swapped corners', () => {
        expect(clampZoomRegion([
            100,
            50,
            300,
            250,
        ], VIEWPORT)).toEqual({
            x: 100,
            y: 50,
            width: 200,
            height: 200,
        });
        expect(clampZoomRegion([
            300,
            250,
            100,
            50,
        ], VIEWPORT)).toEqual({
            x: 100,
            y: 50,
            width: 200,
            height: 200,
        });
    });

    it('clips a region that overhangs the viewport and keeps at least one pixel', () => {
        expect(clampZoomRegion([
            1200,
            700,
            1500,
            900,
        ], VIEWPORT)).toEqual({
            x: 1200,
            y: 700,
            width: 80,
            height: 100,
        });
        expect(clampZoomRegion([
            -20,
            -20,
            -10,
            -10,
        ], VIEWPORT)).toEqual({
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        });
        expect(clampZoomRegion([
            2000,
            900,
            2100,
            950,
        ], VIEWPORT)).toEqual({
            x: 1279,
            y: 799,
            width: 1,
            height: 1,
        });
    });
});

describe('xdotool key mapping', () => {
    it('maps modifier aliases and function keys to puppeteer names', () => {
        expect(mapXdotoolKey('ctrl')).toBe('Control');
        expect(mapXdotoolKey('cmd')).toBe('Meta');
        expect(mapXdotoolKey('super')).toBe('Meta');
        expect(mapXdotoolKey('alt')).toBe('Alt');
        expect(mapXdotoolKey('f5')).toBe('F5');
        expect(mapXdotoolKey('F12')).toBe('F12');
        expect(mapXdotoolKey('a')).toBe('a');
        expect(mapXdotoolKey('plus')).toBe('+');
    });

    it('splits chords into modifiers and main keys', () => {
        expect(parseKeyChord('ctrl+shift+f')).toEqual({
            modifiers: [
                'Control',
                'Shift',
            ],
            main: ['f'],
        });
        expect(parseKeyChord('Return')).toEqual({
            modifiers: [],
            main: ['Return'].map(mapXdotoolKey),
        });
        expect(parseKeyChord(' cmd + s ').modifiers).toEqual(['Meta']);
    });

    it('treats a lone plus sign as the plus key rather than an empty chord', () => {
        expect(parseKeyChord('+')).toEqual({
            modifiers: [],
            main: ['+'],
        });
    });
});
