import packageJson from '@root-package';

const bundledApplicationVersion = packageJson.version.trim();

if (!bundledApplicationVersion) {
    throw new Error('The root package.json must define the canonical application version.');
}

/**
 * Packaged builds use Electron's signed bundle metadata. Development runs use
 * the version compiled from the repository manifest because the generic
 * Electron.app bundle otherwise reports the Electron runtime version.
 */
export function resolveApplicationVersion(app: {
    getVersion(): string;
    isPackaged: boolean;
}) {
    return app.isPackaged ? app.getVersion() : bundledApplicationVersion;
}

export const canonicalBundledApplicationVersion = bundledApplicationVersion;
