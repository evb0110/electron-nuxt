import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateElectronBuilderResources } from '@scripts/generateElectronBuilderResources';
import { generateNativeToolProtocols } from '@scripts/generateNativeToolProtocols';
import { generatePlatformApiArtifacts } from '@scripts/platform-api/generatePlatformApiArtifacts';

export async function generateBuildArtifacts() {
    const changed = await Promise.all([
        generateElectronBuilderResources(),
        generateNativeToolProtocols(),
        generatePlatformApiArtifacts(),
    ]);
    return changed.some(Boolean);
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun && await generateBuildArtifacts()) {
    console.info('Generated build artifacts.');
}
