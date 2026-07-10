import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ISyncVendorResult {
    count: number
    drifted: string[]
    skipped?: string
}

interface ILandingVendorModule {syncVendor: (options?: {
    check?: boolean
    landingRoot?: string
    repoPackages?: string
}) => ISyncVendorResult}

const repoRoot = resolve(import.meta.dirname, '..');
const landingRoot = resolve(repoRoot, 'landing');
const repoPackages = resolve(repoRoot, 'packages');
const { syncVendor } = await import(
    pathToFileURL(resolve(landingRoot, 'scripts/vendor.mjs')).href
) as ILandingVendorModule;

try {
    const result = syncVendor({
        check: true,
        landingRoot,
        repoPackages,
    });
    console.log(result.skipped ?? 'landing/vendor is in sync with packages.');
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
