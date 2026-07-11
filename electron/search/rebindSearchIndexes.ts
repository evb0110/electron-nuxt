import {
    rm,
    writeFile,
} from 'node:fs/promises';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    loadSearchIndex,
    SEARCH_INDEX_SCHEMA_VERSION,
} from '@electron/search/indexBuilder';
import {
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import {stringifyLegacyJsonSearchIndex} from '@electron/search/stringifyLegacyJsonSearchIndex';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';

export async function rebindSearchIndexes(
    pdfPath: string,
    previousRevision: TDocumentRevisionToken,
    nextRevision: TDocumentRevisionToken,
) {
    const [
        legacy,
        compact,
    ] = await Promise.all([
        loadSearchIndex(pdfPath, previousRevision),
        loadCompactSearchIndex(pdfPath, {documentRevision: previousRevision}),
    ]);
    await Promise.all([
        legacy
            ? (async () => {
                const indexPath = `${pdfPath}.index.json`;
                const tempPath = makeSiblingTempPath(indexPath);
                try {
                    await writeFile(tempPath, stringifyLegacyJsonSearchIndex({
                        ...legacy,
                        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
                        documentRevision: {token: nextRevision},
                        createdAt: Date.now(),
                    }), 'utf8');
                    await atomicReplace(tempPath, indexPath);
                } finally {
                    await rm(tempPath, {force: true});
                }
            })()
            : Promise.resolve(),
        compact
            ? persistCompactSearchIndex(pdfPath, {
                documentRevision: nextRevision,
                pageCount: compact.pageCount,
                pages: compact.pages,
                textSource: compact.textSource,
            })
            : Promise.resolve(),
    ]);
    return legacy !== null || compact !== null;
}
