export function appendTextChunkWithByteCap(current: string, chunk: Buffer, maxBytes: number) {
    const chunkText = chunk.toString();
    if (maxBytes <= 0) {
        return {
            text: '',
            truncated: true,
        };
    }

    const nextValue = current + chunkText;
    if (Buffer.byteLength(nextValue, 'utf8') <= maxBytes) {
        return {
            text: nextValue,
            truncated: false,
        };
    }

    const targetTailBytes = Math.max(1, Math.floor(maxBytes * 0.9));
    let tail = nextValue;
    while (Buffer.byteLength(tail, 'utf8') > targetTailBytes && tail.length > 1) {
        tail = tail.slice(Math.floor(tail.length * 0.1));
    }

    return {
        text: tail,
        truncated: true,
    };
}
