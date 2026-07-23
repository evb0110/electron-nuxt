import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IHostResourceProfileSnapshot,
    THostResourceTier,
} from '@contracts/hostResourceProfile';
import { resolveOcrResourcePolicy } from '@electron/ocr/ocrRuntimePolicy';

const GIB = 1024 ** 3;

function createResourceProfile(
    logicalCpus: number,
    totalRamBytes: number,
    tier: THostResourceTier,
): IHostResourceProfileSnapshot {
    return {
        logicalCpus,
        totalRamBytes,
        safeMode: false,
        detectedTier: tier,
        performanceMode: 'auto',
        tier,
    };
}

describe('resolveOcrResourcePolicy', () => {
    it('uses one page and worker slot on low-tier hosts', () => {
        expect(resolveOcrResourcePolicy(
            createResourceProfile(4, 8 * GIB, 'low'),
            {},
        )).toEqual({globalPageSlots: 1});
    });

    it('preserves the existing medium and high formulas', () => {
        expect(resolveOcrResourcePolicy(
            createResourceProfile(8, 16 * GIB, 'medium'),
            {},
        )).toEqual({globalPageSlots: 4});
        expect(resolveOcrResourcePolicy(
            createResourceProfile(16, 32 * GIB, 'high'),
            {},
        )).toEqual({globalPageSlots: 8});
    });

    it('gives environment overrides highest precedence', () => {
        expect(resolveOcrResourcePolicy(
            createResourceProfile(2, 4 * GIB, 'low'),
            {OCR_GLOBAL_PAGE_SLOTS: '12'},
        )).toEqual({globalPageSlots: 8});
    });
});
