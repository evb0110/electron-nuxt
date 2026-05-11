async function ensureFileHandleReadPermission(handle: FileSystemFileHandle) {
    interface IFileSystemHandlePermissionDescriptor {mode: 'read';}

    const permissionHandle = handle as FileSystemFileHandle & {
        queryPermission?: (descriptor?: IFileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
        requestPermission?: (descriptor?: IFileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
    };
    const descriptor: IFileSystemHandlePermissionDescriptor = { mode: 'read' };

    if (typeof permissionHandle.queryPermission === 'function') {
        const currentPermission = await permissionHandle.queryPermission(descriptor);
        if (currentPermission === 'granted') {
            return;
        }
    }

    if (typeof permissionHandle.requestPermission === 'function') {
        const requestedPermission = await permissionHandle.requestPermission(descriptor);
        if (requestedPermission === 'granted') {
            return;
        }
    }
}

export async function readFileHandleBytes(
    handle: FileSystemFileHandle,
    offset?: number,
    length?: number,
) {
    await ensureFileHandleReadPermission(handle);
    const file = await handle.getFile();
    if (typeof offset === 'number' && typeof length === 'number') {
        const start = Math.max(0, offset);
        const end = Math.max(start, start + Math.max(0, length));
        return {
            size: file.size,
            bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()),
        };
    }

    return {
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
    };
}

export async function readFileHandleSize(handle: FileSystemFileHandle) {
    await ensureFileHandleReadPermission(handle);
    const file = await handle.getFile();
    return file.size;
}
