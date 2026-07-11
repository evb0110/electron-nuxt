import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TDjvuCompactFidelityPreset } from '@contracts/djvuConversionPolicy';

const COMPACT_FIDELITY = {
    small: {
        backgroundQuality: 70,
        photoQuality: 75,
        ppiCap: 180,
    },
    balanced: {
        backgroundQuality: 80,
        photoQuality: 85,
        ppiCap: 300,
    },
    archival: {
        backgroundQuality: 95,
        photoQuality: 95,
        ppiCap: 1200,
    },
} as const;

export function getCompactDjvuFidelity(preset: TDjvuCompactFidelityPreset | undefined) {
    return COMPACT_FIDELITY[preset ?? 'balanced'];
}

export function readCompactDjvuIntegerEnv(name: string, defaultValue: number, minValue: number, maxValue: number) {
    const parsed = Number.parseInt(process.env[name] ?? `${defaultValue}`, 10);
    return !Number.isFinite(parsed) || parsed < minValue ? defaultValue : Math.min(parsed, maxValue);
}

export function writeCompactDjvuFidelityManifest(tempDir: string, preset: TDjvuCompactFidelityPreset | undefined, pages: ReadonlyArray<{
    pageNumber: number;
    kind: string;
    reason: string;
    effectivePpi: number;
    jpegQuality?: number;
}>) {
    return writeFile(join(tempDir, 'compact-fidelity.json'), JSON.stringify({
        version: 1,
        preset: preset ?? 'balanced',
        pages: pages.map(({
            pageNumber,
            kind,
            reason,
            effectivePpi,
            jpegQuality,
        }) => ({
            pageNumber,
            kind,
            reason,
            effectivePpi,
            ...(jpegQuality === undefined ? {} : {jpegQuality}),
        })),
    }, null, 2), 'utf8');
}
