import { realpathSync } from 'fs';
import { resolve } from 'path';

function decodeURIComponentRepeatedly(value: string, maxPasses = 3) {
    let decoded = value;

    for (let pass = 0; pass < maxPasses; pass += 1) {
        try {
            const nextDecoded = decodeURIComponent(decoded);
            if (nextDecoded === decoded) {
                break;
            }
            decoded = nextDecoded;
        } catch {
            break;
        }
    }

    return decoded;
}

function repairUtf8BytesReadAsLatin1(value: string) {
    try {
        const repaired = Buffer.from(value, 'latin1').toString('utf8');
        return repaired.includes('\uFFFD') ? null : repaired;
    } catch {
        return null;
    }
}

function addCandidate(candidates: string[], seen: Set<string>, candidate: string | null | undefined) {
    const normalized = candidate?.trim();
    if (!normalized || seen.has(normalized)) {
        return;
    }

    seen.add(normalized);
    candidates.push(normalized);
}

export function getPossiblyEncodedPathCandidates(filePath: string) {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const trimmedPath = filePath.trim();
    addCandidate(candidates, seen, trimmedPath);

    const decodedPath = decodeURIComponentRepeatedly(trimmedPath);
    addCandidate(candidates, seen, decodedPath);

    for (const candidate of [...candidates]) {
        addCandidate(candidates, seen, repairUtf8BytesReadAsLatin1(candidate));
    }

    return candidates;
}

export function normalizePossiblyEncodedExistingPath(filePath: string) {
    for (const candidate of getPossiblyEncodedPathCandidates(filePath)) {
        try {
            return realpathSync.native(resolve(candidate));
        } catch {
            // Try the next representation.
        }
    }

    return null;
}
