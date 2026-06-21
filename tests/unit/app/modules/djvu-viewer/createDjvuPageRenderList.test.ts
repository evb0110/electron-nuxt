import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDjvuPageRenderList } from '@app/modules/djvu-viewer/createDjvuPageRenderList';

describe('createDjvuPageRenderList', () => {
    it('prefetches around the visible window and prioritizes forward scroll direction', () => {
        expect(createDjvuPageRenderList({
            anchorPage: 10,
            direction: 1,
            endPage: 12,
            prefetchPages: 2,
            startPage: 8,
            totalPages: 20,
        })).toEqual([
            10,
            11,
            9,
            12,
            13,
            14,
            8,
            7,
            6,
        ]);
    });

    it('prioritizes previous pages while scrolling upward', () => {
        expect(createDjvuPageRenderList({
            anchorPage: 10,
            direction: -1,
            endPage: 12,
            prefetchPages: 2,
            startPage: 8,
            totalPages: 20,
        })).toEqual([
            10,
            9,
            11,
            8,
            7,
            6,
            12,
            13,
            14,
        ]);
    });

    it('balances both sides when scroll direction is unknown', () => {
        expect(createDjvuPageRenderList({
            anchorPage: 10,
            direction: 0,
            endPage: 12,
            prefetchPages: 2,
            startPage: 8,
            totalPages: 20,
        })).toEqual([
            10,
            11,
            9,
            12,
            8,
            13,
            7,
            14,
            6,
        ]);
    });

    it('clamps prefetch ranges at document edges', () => {
        expect(createDjvuPageRenderList({
            anchorPage: 1,
            direction: 1,
            endPage: 2,
            prefetchPages: 4,
            startPage: 1,
            totalPages: 5,
        })).toEqual([
            1,
            2,
            3,
            4,
            5,
        ]);
    });
});
