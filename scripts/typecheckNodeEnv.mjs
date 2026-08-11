const DEFAULT_TYPECHECK_HEAP_MB = 4096;
const MAX_OLD_SPACE_OPTION_PATTERN = /(?:^|\s)--max-old-space-size(?:=|\s+)\d+(?=\s|$)/u;

export function withTypecheckNodeHeap(env = process.env) {
    const nodeOptions = env.NODE_OPTIONS?.trim() ?? '';
    if (MAX_OLD_SPACE_OPTION_PATTERN.test(nodeOptions)) {
        return {...env};
    }

    return {
        ...env,
        NODE_OPTIONS: [
            nodeOptions,
            `--max-old-space-size=${DEFAULT_TYPECHECK_HEAP_MB}`,
        ].filter(Boolean).join(' '),
    };
}
