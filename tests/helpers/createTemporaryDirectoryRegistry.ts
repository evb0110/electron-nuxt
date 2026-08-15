import {rm} from 'node:fs/promises';

export function createTemporaryDirectoryRegistry() {
    const directories = new Set<string>();

    return {
        async cleanup() {
            const registeredDirectories = [...directories];
            directories.clear();
            await Promise.all(registeredDirectories.map(directory => rm(directory, {
                force: true,
                recursive: true,
            })));
        },
        register<T extends string>(directory: T) {
            directories.add(directory);
            return directory;
        },
    };
}
