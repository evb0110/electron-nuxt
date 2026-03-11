import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    boxToNormalizedRect,
    marginsToNormalizedRect,
    screenRectToMargins,
} from '@app/utils/pdf-crop-coordinates';

describe('pdf crop coordinates', () => {
    it('clamps each selection edge independently when the drag starts outside the page', () => {
        expect(screenRectToMargins(
            {
                x: -10,
                y: 20,
                width: 60,
                height: 40,
            },
            {
                left: 0,
                top: 0,
                width: 100,
                height: 100,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            0,
        )).toEqual({
            left: 0,
            right: 100,
            top: 20,
            bottom: 40,
        });
    });

    it('maps rotated selections into media-box margins', () => {
        expect(screenRectToMargins(
            {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            },
            {
                left: 0,
                top: 0,
                width: 100,
                height: 100,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 200,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 200,
            },
            90,
        )).toEqual({
            left: 0,
            right: 100,
            top: 100,
            bottom: 0,
        });
    });

    it('normalizes arbitrary crop boxes for preview rendering', () => {
        expect(boxToNormalizedRect(
            {
                x: 50,
                y: 10,
                width: 100,
                height: 70,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
        )).toEqual({
            x: 0.25,
            y: 0.2,
            width: 0.5,
            height: 0.7,
        });

        expect(marginsToNormalizedRect({
            top: 20,
            bottom: 10,
            left: 50,
            right: 50,
        }, {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        })).toEqual({
            x: 0.25,
            y: 0.2,
            width: 0.5,
            height: 0.7,
        });
    });
});
