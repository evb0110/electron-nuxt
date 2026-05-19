import { existsSync } from 'fs';
import { join } from 'path';

function hasExpectedOcrResources(resourcesBase: string): boolean {
    return existsSync(join(resourcesBase, 'tesseract'));
}

export function resolveOcrResourcesBase(
    moduleDir: string,
    isPackaged: boolean,
): string {
    if (isPackaged) {
        return process.resourcesPath;
    }

    const candidates = [
        join(process.cwd(), 'resources'),
        join(moduleDir, '..', 'resources'),
        join(moduleDir, '..', '..', 'resources'),
        join(moduleDir, '..', '..', '..', 'resources'),
    ];
    const resolved = candidates.find(hasExpectedOcrResources);
    return resolved ?? candidates[0]!;
}
