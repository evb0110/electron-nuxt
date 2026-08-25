import {removeTemporaryDirectory} from '@tests/helpers/removeTemporaryDirectory';

export function createTemporaryDirectoryRegistry() {
    const directories = new Set<string>();

    return {
        async cleanup() {
            const registeredDirectories = [...directories];
            directories.clear();
            await Promise.all(registeredDirectories.map(removeTemporaryDirectory));
        },
        register<T extends string>(directory: T) {
            directories.add(directory);
            return directory;
        },
    };
}
