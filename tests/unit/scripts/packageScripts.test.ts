import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IPackageJson { scripts: Record<string, string> }

async function readPackageJson() {
    return JSON.parse(
        await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as IPackageJson;
}

describe('package scripts', () => {
    it('keeps the web build output checked before deploy', async () => {
        const packageJson = await readPackageJson();

        expect(packageJson.scripts.build).toContain('scripts/check-web-deploy-assets.mjs');
    });

    it('keeps desktop builds staging every Rust native tool', async () => {
        const packageJson = await readPackageJson();

        expect(packageJson.scripts['build:desktop']).toContain('build:pdf-image-combine');
        expect(packageJson.scripts['build:desktop']).toContain('build:pdf-page-ops');
        expect(packageJson.scripts['build:desktop']).toContain('build:pdf-search');
    });

    it('keeps dependency lockstep checks in lint', async () => {
        const packageJson = await readPackageJson();

        expect(packageJson.scripts.lint).toContain('check:dependency-lockstep');
    });
});
