import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    readAvailableScratchBytes,
    resolveRasterHandoff,
} from '@scan-cleanup-core/resolveRasterHandoff';

const mocks = vi.hoisted(() => ({statfs: vi.fn()}));

vi.mock('fs/promises', () => ({statfs: mocks.statfs}));

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
    it('preserves a known zero-byte statfs result', async () => {
        mocks.statfs.mockResolvedValue({
            bavail: 0,
            bsize: 4_096,
        });

        await expect(readAvailableScratchBytes('/scratch')).resolves.toBe(0);
        await expect(resolveRasterHandoff(
            plans,
            '/scratch',
            readAvailableScratchBytes,
        )).resolves.toMatchObject({
            budgetBytes: 0,
            format: 'png',
        });
    });

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

    it('includes conservative per-file overhead above the raw RGB payload', async () => {
        const result = await resolveRasterHandoff([{
            renderDpi: 300,
            raster: {
                dpi: 300,
                height: 100,
                width: 100,
            },
        }], '/scratch', vi.fn(async () => null));

        expect(result.estimatedBytes).toBe(100 * 100 * 3 + 64 * 1024);
    });
});
