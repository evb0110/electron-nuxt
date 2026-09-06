export interface IDisposalFlag {
    isDisposed(): boolean;
    dispose(): void;
}

// Reads go through a call so a check made before an await does not narrow the
// flag for every check that follows it.
export function createDisposalFlag(): IDisposalFlag {
    let disposed = false as boolean;
    return {
        isDisposed: () => disposed,
        dispose: () => {
            disposed = true;
        },
    };
}
