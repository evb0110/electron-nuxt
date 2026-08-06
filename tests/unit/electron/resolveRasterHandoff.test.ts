import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {resolveRasterHandoff} from '@scan-cleanup-core/resolveRasterHandoff';

const MIB = 1024 * 1024;

const plans = [{
    renderDpi: 300,
    raster: {
        dpi: 300,
        height: 10_000,
        width: 10_000,
    },
}];

describe('scan-cleanup raster handoff scratch budget', () => {
    it('keeps the fallback floor when scratch availability is unknown', async () => {
        const result = await resolveRasterHandoff(
            plans,
            '/scratch',
            vi.fn(async () => null),
        );

        expect(result).toMatchObject({
            budgetBytes: 512 * MIB,
            format: 'ppm',
        });
    });

    it('caps the floor at known free space minus the reserve', async () => {
        const result = await resolveRasterHandoff(
            plans,
            '/scratch',
            vi.fn(async () => 700 * MIB),
        );

        expect(result).toMatchObject({
            budgetBytes: 188 * MIB,
            format: 'png',
        });
    });

    it('allows no raw-raster budget when known free space cannot cover the reserve', async () => {
        const result = await resolveRasterHandoff(
            plans,
            '/scratch',
            vi.fn(async () => 512 * MIB),
        );

        expect(result).toMatchObject({
            budgetBytes: 0,
            format: 'png',
        });
    });
});
