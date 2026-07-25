import type {
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type {
    AnnotationEntity,
    AnnotationId,
    IIdentityBindingEvent,
    IShapeEntity,
    IStickyNoteEntity,
    ITextMarkupEntity,
    ISavedSemanticEntry,
    ITextMarkupOverlapCandidate,
    ITextMarkupSelectionProjection,
    TAnnotationStyle,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    buildTextMarkupSelectionPlan,
    normalizeAnnotationText,
    remapSavedSemanticFingerprint,
    saveFrontierEntityBaseline,
    semanticEntityFingerprint,
    semanticSnapshot,
    semanticSnapshotsEqual,
    snapshotOfKind,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { ExternalIdentityIndex } from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {
    findImportedShapeMatchIndex,
    getNormalizedShapeStableKey,
    shapeStableRefsMatch,
} from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-identity/shapeAnnotationIdentity';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
interface IHistoryEntry {
    before: AnnotationEntity | null;
    after: AnnotationEntity | null
}
interface IAnnotationHistoryCommand {
    cmd: () => void;
    undo: () => void;
}
export interface IAnnotationHistoryAuthority {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    registerCommand: (command: IAnnotationHistoryCommand) => void;
    undo: () => boolean;
    redo: () => boolean;
}
export interface IAnnotationSaveFrontier {
    readonly documentRevisionToken: TDocumentRevisionToken | null;
    readonly epoch: number;
    readonly entityBaselineHash: string;
    readonly revisions: ReadonlyMap<AnnotationId, number>;
}
/** Identifies the document bytes an embedded-shape scan was taken from. */
export interface IShapeImportSource {
    readonly documentKey: string | null;
    readonly path: string | null;
}
/** A scanned shape record plus the canonical id its document identity derives. */
export interface IShapeImportProposal {
    readonly annotationId: AnnotationId;
    readonly geometry: IShapeAnnotation;
}
/**
 * `replace` discards the previous document's shapes, `reconcile` merges a scan of
 * the same document, and `adopt-self-saved` adopts identities from bytes this
 * session wrote once the reload delivers them.
 */
export type TShapeImportMode = 'replace' | 'reconcile' | 'adopt-self-saved';
export interface IShapeImportPlan {
    readonly mode: TShapeImportMode;
    readonly skipRerender: boolean;
    readonly reason: string;
}
/** `prime` is the pre-acknowledgement identity pass; it is never a planned mode. */
type TShapeApplyMode = TShapeImportMode | 'prime';
type TListener = (entities: readonly AnnotationEntity[]) => void;

function cloneEntity<T extends AnnotationEntity>(entity: T): T {
    return structuredClone(entity);
}

interface ISavePreparationChange {
    readonly beforeIdentity: AnnotationEntity['identity'];
    readonly afterIdentity: AnnotationEntity['identity'];
    readonly beforePersistedRevision: number;
    readonly afterPersistedRevision: number;
}

interface ISaveFrontierState {readonly preparedChanges: Map<AnnotationId, ISavePreparationChange>;}

interface IPendingMarkupSubtypeIntent {
    readonly aliases: ReadonlySet<string>;
    readonly subtype: TMarkupSubtype;
}

class LocalAnnotationHistoryAuthority implements IAnnotationHistoryAuthority {
    readonly #undo: IAnnotationHistoryCommand[] = [];
    readonly #redo: IAnnotationHistoryCommand[] = [];

    get canUndo() { return this.#undo.length > 0; }
    get canRedo() { return this.#redo.length > 0; }
    registerCommand(command: IAnnotationHistoryCommand) {
        this.#undo.push(command);
        this.#redo.length = 0;
    }
    undo() {
        const command = this.#undo.pop();
        if (!command) {
            return false;
        }
        command.undo();
        this.#redo.push(command);
        return true;
    }
    redo() {
        const command = this.#redo.pop();
        if (!command) {
            return false;
        }
        command.cmd();
        this.#undo.push(command);
        return true;
    }
}

export class AnnotationStore {
    readonly #entities = new Map<AnnotationId, AnnotationEntity>();
    readonly #identities = new ExternalIdentityIndex();
    readonly #listeners = new Set<TListener>();
    readonly #history: IAnnotationHistoryAuthority;
    readonly #saveFrontiers = new WeakMap<IAnnotationSaveFrontier, ISaveFrontierState>();
    readonly #pdfjsObservedTransientIds = new Set<AnnotationId>();
    readonly #pendingMarkupSubtypes = new Map<string, IPendingMarkupSubtypeIntent>();
    #savedSemanticSnapshot = new Map<AnnotationId, ISavedSemanticEntry>();
    #mutationEpoch = 0;
    #shapeImportSource: IShapeImportSource = {
        documentKey: null,
        path: null,
    };
    #hasShapeImportBaseline = false;
    #adoptSelfSavedShapesOnNextImport = false;

    constructor(history: IAnnotationHistoryAuthority = new LocalAnnotationHistoryAuthority()) {
        this.#history = history;
    }

    list(options: { includeDeleted?: boolean } = {}) {
        return Array.from(this.#entities.values())
            .filter(entity => options.includeDeleted === true || !entity.deleted)
            .map(cloneEntity);
    }

    get(id: AnnotationId) {
        const entity = this.#entities.get(id);
        return entity ? cloneEntity(entity) : null;
    }

    subscribe(listener: TListener) {
        this.#listeners.add(listener);
        listener(this.list());
        return () => this.#listeners.delete(listener);
    }

    import(entity: AnnotationEntity, options: { preserveSavedBaseline?: boolean } = {}) {
        const wasSemanticallyClean = !this.hasChangesSinceSavedBaseline();
        const current = this.#entities.get(entity.identity.id);
        if (current && current.revision > entity.revision) {
            return current;
        }
        const pendingSubtype = entity.kind === 'text-markup'
            ? this.#findPendingMarkupSubtype(this.#externalIdentityKeys(entity.identity))
            : null;
        const imported = pendingSubtype
            ? {
                ...entity,
                subtype: pendingSubtype.subtype,
            }
            : entity;
        this.#identities.bind(imported.identity);
        this.#entities.set(imported.identity.id, cloneEntity(imported));
        if (pendingSubtype) {
            this.#forgetPendingMarkupSubtype(pendingSubtype);
        }
        if (imported.persistedRevision >= 0 && wasSemanticallyClean && !options.preserveSavedBaseline) {
            this.#savedSemanticSnapshot = semanticSnapshot(this.#entities.values());
        }
        this.#mutationEpoch += 1;
        this.#emit();
        return imported;
    }

    createStickyNote(entity: IStickyNoteEntity) { return this.#create(entity); }
    createTextMarkup(entity: ITextMarkupEntity) { return this.#create(entity); }
    createShape(entity: IShapeEntity) { return this.#create(entity); }

    applyTextMarkupSelection(
        created: ITextMarkupEntity,
        overlapCandidates: readonly ITextMarkupOverlapCandidate[],
    ): ITextMarkupSelectionProjection {
        if (this.#entities.has(created.identity.id)) {
            throw new Error(`Duplicate AnnotationId ${created.identity.id}`);
        }
        if (created.revision !== 0 || created.persistedRevision !== -1) {
            throw new Error('New annotations must start at revision 0 with persistedRevision -1');
        }
        const plan = buildTextMarkupSelectionPlan({
            created,
            overlapCandidates,
            entities: Array.from(this.#entities.values()),
        });
        const entries: IHistoryEntry[] = plan.replacements.map(replacement => ({
            before: cloneEntity(replacement.before),
            after: cloneEntity(replacement.after),
        }));
        entries.push({
            before: null,
            after: cloneEntity(created),
        });
        this.#identities.bind(created.identity);
        this.#commitBatch(entries);
        return plan.projection;
    }

    /**
     * Hard-removes entities this authority no longer recognises: shapes replaced
     * by a new source import, and tombstones whose annotation is gone from the
     * imported document. Undoable mutations use {@link delete} instead; forgetting
     * drops the saved baseline entry so a forgotten annotation cannot report dirty.
     */
    forget(ids: ReadonlySet<AnnotationId>) {
        let removed = false;
        ids.forEach((id) => {
            const entity = this.#entities.get(id);
            removed = this.#entities.delete(id) || removed;
            this.#savedSemanticSnapshot.delete(id);
            this.#pdfjsObservedTransientIds.delete(id);
            if (entity) {
                this.forgetPendingMarkupSubtypes(this.#externalIdentityKeys(entity.identity));
            }
        });
        if (!removed) {
            return;
        }
        this.#rebindIdentities();
        this.#mutationEpoch += 1;
        this.#emit();
    }

    setNoteText(id: AnnotationId, text: string) {
        return this.#update(id, (entity) => {
            if (entity.kind === 'shape') throw new Error('setNoteText requires a note-bearing annotation');
            return {
                ...entity,
                text: normalizeAnnotationText(text),
            };
        });
    }

    setStyle(id: AnnotationId, style: TAnnotationStyle) {
        return this.#update(id, (entity) => {
            if (entity.kind === 'shape') {
                const geometry = {...structuredClone(entity.geometry)};
                if (style.color !== null) geometry.color = style.color;
                if ('fillColor' in style && style.fillColor !== undefined) geometry.fillColor = style.fillColor;
                if ('opacity' in style && style.opacity !== undefined && style.opacity !== null) geometry.opacity = style.opacity;
                if ('strokeWidth' in style && style.strokeWidth !== undefined) geometry.strokeWidth = style.strokeWidth;
                return {
                    ...entity,
                    geometry,
                };
            }
            return {
                ...entity,
                ...style,
            };
        });
    }

    moveAnchor(id: AnnotationId, anchor: IAnnotationMarkerRect) {
        return this.#update(id, (entity) => {
            if (entity.kind !== 'sticky-note') throw new Error('moveAnchor requires a sticky note');
            return {
                ...entity,
                anchor: structuredClone(anchor),
            };
        });
    }

    /**
     * `historyBeforeGeometry` restores the pre-drag geometry as the undo target
     * when live previews already advanced the entity past its committed state.
     */
    replaceShapeGeometry(
        id: AnnotationId,
        geometry: IShapeEntity['geometry'],
        historyBeforeGeometry?: IShapeEntity['geometry'],
    ) {
        const current = this.#requireShape(id, geometry);
        const before = historyBeforeGeometry
            ? {
                ...current,
                geometry: structuredClone(historyBeforeGeometry),
                revision: Math.max(0, current.revision - 1),
            }
            : cloneEntity(current);
        const after = {
            ...current,
            geometry: structuredClone(geometry),
            revision: current.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#commit({
            before,
            after,
        });
        return cloneEntity(after);
    }

    /** Live drag/resize feedback: advances canonical geometry without a history step. */
    previewShapeGeometry(id: AnnotationId, geometry: IShapeEntity['geometry']) {
        const before = this.#requireShape(id, geometry);
        const after = {
            ...before,
            geometry: structuredClone(geometry),
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#entities.set(id, cloneEntity(after));
        this.#mutationEpoch += 1;
        this.#emit();
        return cloneEntity(after);
    }

    /** Live shape geometries; the only shape read model. */
    listShapes(options: { includeDeleted?: boolean } = {}) {
        return this.list({includeDeleted: options.includeDeleted === true})
            .filter((entity): entity is IShapeEntity => entity.kind === 'shape')
            .sort((left, right) => left.pageIndex - right.pageIndex);
    }

    /**
     * Records that the next embedded-shape scan re-reads bytes this session just
     * wrote. It is the import fence that feeds {@link planShapeImport}; the mode
     * decision itself never leaves this authority.
     */
    adoptPersistedShapesOnNextImport() { this.#adoptSelfSavedShapesOnNextImport = true; }
    clearPendingShapeImportAdoption() { this.#adoptSelfSavedShapesOnNextImport = false; }
    get hasShapeImportBaseline() { return this.#hasShapeImportBaseline; }

    /** True when a source change keeps the shapes this authority already imported. */
    preservesShapeImportBaseline(source: IShapeImportSource) {
        return this.#hasShapeImportBaseline && (
            this.#adoptSelfSavedShapesOnNextImport
            || (source.documentKey !== null && source.documentKey === this.#shapeImportSource.documentKey)
            || (source.documentKey === null && source.path !== null && source.path === this.#shapeImportSource.path)
        );
    }

    planShapeImport(source: IShapeImportSource): IShapeImportPlan {
        const hasShapeState = this.listShapes({includeDeleted: true}).length > 0;
        const isSameSource = source.documentKey !== null
            ? source.documentKey === this.#shapeImportSource.documentKey
            : source.path === this.#shapeImportSource.path;
        if (
            this.#adoptSelfSavedShapesOnNextImport
            && isSameSource
            && (this.#hasShapeImportBaseline || hasShapeState)
        ) {
            return {
                mode: 'adopt-self-saved',
                skipRerender: true,
                reason: 'preserved-live-session-save',
            };
        }
        if (this.#hasShapeImportBaseline && isSameSource) {
            return {
                mode: 'reconcile',
                skipRerender: false,
                reason: this.hasChangesSinceSavedBaseline('shape')
                    ? 'same-source-dirty-shape-reconcile'
                    : 'same-source-clean-shape-reconcile',
            };
        }
        if (hasShapeState) {
            return {
                mode: 'reconcile',
                skipRerender: false,
                reason: 'live-state-created-during-deferred-import',
            };
        }
        return {
            mode: 'replace',
            skipRerender: false,
            reason: 'new-source-import',
        };
    }

    /** Applies a document scan under the mode this authority chose for it. */
    reconcileImportedShapes(proposals: readonly IShapeImportProposal[], source: IShapeImportSource) {
        const plan = this.planShapeImport(source);
        this.#applyImportedShapes(proposals, plan.mode);
        this.#adoptSelfSavedShapesOnNextImport = false;
        this.#hasShapeImportBaseline = true;
        this.#shapeImportSource = {
            documentKey: source.documentKey,
            path: source.path,
        };
        return plan;
    }

    /**
     * Adopts the identities the bytes about to be persisted assigned to shapes.
     * Only external identity moves, so a frontier captured before the write still
     * validates: this is identity reconciliation, not a captured mutation.
     */
    primeImportedShapes(
        proposals: readonly IShapeImportProposal[],
        frontier: IAnnotationSaveFrontier,
    ) {
        if (!this.#saveFrontiers.has(frontier)) {
            return false;
        }
        this.#applyImportedShapes(proposals, 'prime', frontier);
        return true;
    }

    resetShapeImportBaseline() {
        this.#adoptSelfSavedShapesOnNextImport = false;
        this.#hasShapeImportBaseline = false;
        this.#shapeImportSource = {
            documentKey: null,
            path: null,
        };
        this.#applyImportedShapes([], 'replace');
    }

    /** Rebases the shape baseline onto the state a completed save persisted. */
    markShapesSaved() {
        const shapes = this.listShapes({includeDeleted: true});
        this.forget(new Set(shapes.filter(entity => entity.deleted).map(entity => entity.identity.id)));
        this.adoptEntitiesAsSavedBaseline(new Set(
            shapes.filter(entity => !entity.deleted).map(entity => entity.identity.id),
        ));
    }

    delete(id: AnnotationId) {
        return this.#update(id, entity => ({
            ...entity,
            deleted: true,
        }));
    }

    restore(id: AnnotationId) {
        const before = this.#require(id);
        if (!before.deleted) {
            return cloneEntity(before);
        }
        const after = {
            ...before,
            deleted: false,
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#commit({
            before: cloneEntity(before),
            after,
        });
        return cloneEntity(after);
    }

    bindIdentity(event: IIdentityBindingEvent) {
        const entity = this.#require(event.annotationId);
        if (entity.revision !== event.expectedRevision) {
            throw new Error(`Stale identity binding for ${event.annotationId}`);
        }
        const identity = {
            ...entity.identity,
            ...event.bindings,
        };
        this.#identities.bind(identity);
        this.#entities.set(event.annotationId, {
            ...entity,
            identity,
        });
        this.#mutationEpoch += 1;
        this.#emit();
    }

    resolveExternal(bindings: Parameters<ExternalIdentityIndex['resolve']>[0]) {
        return this.#identities.resolve(bindings);
    }

    /**
     * Text-markup subtypes keyed by every external id a PDF.js editor or a save
     * projector can present. It replaces the copies those consumers used to
     * accumulate: the subtype of a markup annotation is entity state.
     */
    markupSubtypesByExternalId(): ReadonlyMap<string, TMarkupSubtype> {
        const subtypes = new Map(Array.from(this.#pendingMarkupSubtypes, ([
            alias,
            intent,
        ]) => [
            alias,
            intent.subtype,
        ]));
        this.#entities.forEach((entity) => {
            if (entity.kind !== 'text-markup' || entity.deleted) {
                return;
            }
            this.#externalIdentityKeys(entity.identity)
                .forEach(externalId => subtypes.set(externalId, entity.subtype));
        });
        return subtypes;
    }

    /**
     * Queues a subtype intent until PDF.js ingestion materializes the canonical
     * entity. An immediate save therefore observes the user's tool choice
     * without a bridge-owned subtype mirror.
     */
    setPendingMarkupSubtype(externalIds: readonly string[], subtype: TMarkupSubtype) {
        const aliases = this.#markupSubtypeAliases(externalIds);
        const connected = new Set(Array.from(aliases)
            .map(alias => this.#pendingMarkupSubtypes.get(alias))
            .filter((intent): intent is IPendingMarkupSubtypeIntent => Boolean(intent)));
        connected.forEach(intent => intent.aliases.forEach(alias => aliases.add(alias)));
        connected.forEach(intent => this.#forgetPendingMarkupSubtype(intent));
        const intent = {
            aliases,
            subtype,
        };
        aliases.forEach(alias => this.#pendingMarkupSubtypes.set(alias, intent));
    }

    resolveMarkupSubtype(externalIds: readonly string[]) {
        const canonical = this.markupSubtypesByExternalId();
        return externalIds
            .map(id => canonical.get(id))
            .find((subtype): subtype is TMarkupSubtype => subtype !== undefined)
            ?? null;
    }

    clearPendingMarkupSubtypes() {
        this.#pendingMarkupSubtypes.clear();
    }

    forgetPendingMarkupSubtypes(externalIds: readonly string[]) {
        const aliases = this.#markupSubtypeAliases(externalIds);
        const intents = new Set(Array.from(aliases)
            .map(alias => this.#pendingMarkupSubtypes.get(alias))
            .filter((intent): intent is IPendingMarkupSubtypeIntent => Boolean(intent)));
        intents.forEach(intent => this.#forgetPendingMarkupSubtype(intent));
        aliases.forEach(alias => this.#pendingMarkupSubtypes.delete(alias));
    }

    acknowledgePendingMarkupSubtype(annotationId: AnnotationId, externalIds: readonly string[]) {
        const entity = this.#entities.get(annotationId);
        if (!entity) {
            return null;
        }
        const intent = this.#findPendingMarkupSubtype([
            ...externalIds,
            ...this.#externalIdentityKeys(entity.identity),
        ]);
        if (!intent) {
            return cloneEntity(entity);
        }
        this.#forgetPendingMarkupSubtype(intent);
        if (entity.kind !== 'text-markup' || entity.deleted || entity.subtype === intent.subtype) {
            return cloneEntity(entity);
        }
        return this.#update(annotationId, current => current.kind === 'text-markup'
            ? {
                ...current,
                subtype: intent.subtype,
            }
            : current);
    }

    /**
     * Canonical decision for a PDF.js editor-presence proposal. Callers forward
     * the external ids the editor layer currently renders; the store alone
     * decides whether that evidence restores a canonically-deleted entity or
     * tombstones a still-transient one, matching presence against external
     * identity bindings. The saved baseline is preserved because presence
     * reconciliation is never an authored edit.
     */
    reconcileEditorPresence(presentExternalIds: ReadonlySet<string>) {
        this.list({includeDeleted: true}).forEach((entity) => {
            if (entity.kind === 'shape') {
                return;
            }
            const present = [
                entity.identity.pdfRef,
                entity.identity.pdfjsUid,
                entity.identity.elementId,
            ]
                .filter((candidate): candidate is string => Boolean(candidate))
                .some(candidate => presentExternalIds.has(candidate));
            const shouldRestore = present && entity.deleted;
            const shouldDeleteTransient = !present && entity.persistedRevision < 0 && !entity.deleted;
            if (!shouldRestore && !shouldDeleteTransient) {
                return;
            }
            this.import({
                ...entity,
                deleted: !present,
                revision: entity.revision + 1,
                modifiedAt: Date.now(),
            }, {preserveSavedBaseline: true});
        });
    }

    /**
     * Canonical decision for an authoritative-editor-snapshot proposal. Callers
     * forward the canonical ids present in a complete editor snapshot; the store
     * tombstones a transient entity only once it has authoritatively observed
     * that entity present and then absent, and remembers newly observed
     * transients. Owning `#pdfjsObservedTransientIds` here keeps the "present
     * then removed" judgement inside the sole annotation authority.
     */
    reconcileObservedTransients(presentIds: ReadonlySet<AnnotationId>) {
        this.list().forEach((entity) => {
            if (
                entity.persistedRevision >= 0
                || entity.deleted
                || entity.kind === 'shape'
                || presentIds.has(entity.identity.id)
                || !this.#pdfjsObservedTransientIds.has(entity.identity.id)
            ) {
                return;
            }
            this.import({
                ...entity,
                deleted: true,
                revision: entity.revision + 1,
                modifiedAt: Date.now(),
            });
        });
        this.list().forEach((entity) => {
            if (
                entity.persistedRevision < 0
                && !entity.deleted
                && entity.kind !== 'shape'
                && presentIds.has(entity.identity.id)
            ) {
                this.#pdfjsObservedTransientIds.add(entity.identity.id);
            }
        });
    }

    /** Projects a committed page-tree delta without creating a second undo entry. */
    remapPages(delta: IPageIdentityDelta) {
        const newPageByOldPage = new Map<number, number>();
        delta.pages.forEach((page, nextPageIndex) => {
            if ('fromPageNumber' in page) newPageByOldPage.set(page.fromPageNumber - 1, nextPageIndex);
        });
        this.#entities.forEach((entity, id) => {
            const nextPageIndex = newPageByOldPage.get(entity.pageIndex);
            const saved = this.#savedSemanticSnapshot.get(id);
            if (saved !== undefined) {
                this.#savedSemanticSnapshot.set(id, {
                    kind: saved.kind,
                    fingerprint: remapSavedSemanticFingerprint(saved.fingerprint, nextPageIndex),
                });
            }
            if (nextPageIndex === undefined) {
                this.#entities.set(id, {
                    ...entity,
                    deleted: true,
                });
                return;
            }
            this.#entities.set(id, entity.kind === 'shape'
                ? {
                    ...entity,
                    pageIndex: nextPageIndex,
                    geometry: {
                        ...entity.geometry,
                        pageIndex: nextPageIndex,
                    },
                }
                : {
                    ...entity,
                    pageIndex: nextPageIndex,
                });
        });
        this.#mutationEpoch += 1;
        this.#emit();
    }

    beginSave(documentRevisionToken: TDocumentRevisionToken | null = null): IAnnotationSaveFrontier {
        const entities = this.list({includeDeleted: true});
        const frontier: IAnnotationSaveFrontier = {
            documentRevisionToken,
            epoch: this.#mutationEpoch,
            entityBaselineHash: saveFrontierEntityBaseline(entities),
            revisions: new Map(entities.map(entity => [
                entity.identity.id,
                entity.revision,
            ])),
        };
        this.#saveFrontiers.set(frontier, {preparedChanges: new Map()});
        return frontier;
    }

    /**
     * Reverts only identity and persistence metadata written by save preparation.
     * Authored mutations and entities created after capture remain canonical;
     * their revisions still make the captured frontier fail CAS. Each field is
     * restored only while it still equals the value preparation wrote, so later
     * identity reconciliation is preserved too.
     *
     * Ownership is by frontier object identity, so a frontier another store
     * captured — even a structurally identical one — is never applied here.
     * Returns whether this store owned the frontier; a failed save unwinds
     * through `finally`, where throwing would mask the original failure.
     */
    rollbackToSaveFrontier(frontier: IAnnotationSaveFrontier) {
        const state = this.#saveFrontiers.get(frontier);
        if (!state) {
            return false;
        }
        let changed = false;
        state.preparedChanges.forEach((preparation, id) => {
            const entity = this.#entities.get(id);
            if (!entity) {
                return;
            }
            const identity = this.#conditionallyRestoreIdentity(
                entity.identity,
                preparation.beforeIdentity,
                preparation.afterIdentity,
            );
            const persistedRevision = entity.persistedRevision === preparation.afterPersistedRevision
                ? preparation.beforePersistedRevision
                : entity.persistedRevision;
            if (identity !== entity.identity || persistedRevision !== entity.persistedRevision) {
                this.#entities.set(id, {
                    ...entity,
                    identity,
                    persistedRevision,
                });
                changed = true;
            }
        });
        if (changed) {
            this.#rebindIdentities();
            this.#mutationEpoch += 1;
            this.#emit();
        }
        return true;
    }

    acknowledgeSave(
        frontier: IAnnotationSaveFrontier,
        materializedPdfRefs: ReadonlyMap<AnnotationId, string> = new Map(),
        currentDocumentRevisionToken: TDocumentRevisionToken | null = frontier.documentRevisionToken,
    ) {
        this.assertSaveFrontierCurrent(frontier, currentDocumentRevisionToken);
        frontier.revisions.forEach((revision, id) => {
            const entity = this.#entities.get(id);
            if (entity?.revision === revision) {
                const pdfRef = materializedPdfRefs.get(id);
                const identity = pdfRef
                    ? {
                        ...entity.identity,
                        pdfRef,
                    }
                    : entity.identity;
                this.#identities.bind(identity);
                this.#entities.set(id, {
                    ...entity,
                    identity,
                    persistedRevision: revision,
                });
            }
        });
        this.#savedSemanticSnapshot = semanticSnapshot(this.#entities.values());
        this.#emit();
    }

    adoptEntitiesAsSavedBaseline(ids: ReadonlySet<AnnotationId>) {
        ids.forEach((id) => {
            const entity = this.#entities.get(id);
            if (entity) {
                this.#savedSemanticSnapshot.set(id, {
                    kind: entity.kind,
                    fingerprint: semanticEntityFingerprint(entity),
                });
            }
        });
        this.#emit();
    }

    /** `kind` scopes dirty state to one projection, e.g. shape-only save routing. */
    hasChangesSinceSavedBaseline(kind?: AnnotationEntity['kind']) {
        return !semanticSnapshotsEqual(
            snapshotOfKind(semanticSnapshot(this.#entities.values()), kind),
            snapshotOfKind(this.#savedSemanticSnapshot, kind),
        );
    }

    countDirtyPersistedDeletions() {
        return this.dirtyAt(this.beginSave())
            .filter(entity => entity.deleted && entity.persistedRevision >= 0)
            .length;
    }

    assertSaveFrontierCurrent(
        frontier: IAnnotationSaveFrontier,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = frontier.documentRevisionToken,
    ) {
        if (!this.#saveFrontiers.has(frontier)) {
            throw new Error('staleRevisionError: annotation save frontier belongs to another store');
        }
        if (frontier.documentRevisionToken !== currentDocumentRevisionToken) {
            throw new Error('staleRevisionError: document revision changed after the annotation save frontier was captured');
        }
        // External identity reconciliation can legitimately complete while a
        // path-backed native save is being verified. The initial PDF.js scan
        // can also discover already-persisted source annotations after a fast
        // first paint. Neither event changes the user-authored save frontier.
        // Reject changes to captured entities and any newly-created unsaved
        // entity, while allowing identity bindings and late persisted imports.
        const current = new Map(this.list({includeDeleted: true}).map(entity => [
            entity.identity.id,
            entity,
        ]));
        const capturedEntities = Array.from(frontier.revisions, ([id]) => current.get(id))
            .filter((entity): entity is AnnotationEntity => entity !== undefined);
        const capturedEntityChanged = capturedEntities.length !== frontier.revisions.size
            || saveFrontierEntityBaseline(capturedEntities) !== frontier.entityBaselineHash
            || Array.from(frontier.revisions).some(([
                id,
                revision,
            ]) => current.get(id)?.revision !== revision);
        const unsavedEntityCreatedAfterFrontier = Array.from(current.values()).some(entity => (
            !frontier.revisions.has(entity.identity.id)
            && entity.persistedRevision < 0
        ));
        if (capturedEntityChanged || unsavedEntityCreatedAfterFrontier) {
            throw new Error('staleRevisionError: annotations changed after the save frontier was captured');
        }
    }

    dirtyAt(frontier: IAnnotationSaveFrontier) {
        return this.list({includeDeleted: true}).filter(entity => {
            const frontierRevision = frontier.revisions.get(entity.identity.id);
            return frontierRevision !== undefined
                && semanticEntityFingerprint(entity) !== this.#savedSemanticSnapshot.get(entity.identity.id)?.fingerprint;
        });
    }

    undo() { return this.#history.undo(); }
    redo() { return this.#history.redo(); }
    get canUndo() { return this.#history.canUndo; }
    get canRedo() { return this.#history.canRedo; }

    #create(entity: AnnotationEntity) {
        if (this.#entities.has(entity.identity.id)) throw new Error(`Duplicate AnnotationId ${entity.identity.id}`);
        if (entity.revision !== 0 || entity.persistedRevision !== -1) {
            throw new Error('New annotations must start at revision 0 with persistedRevision -1');
        }
        this.#identities.bind(entity.identity);
        this.#commit({
            before: null,
            after: cloneEntity(entity),
        });
        return entity;
    }

    #update(id: AnnotationId, update: (entity: AnnotationEntity) => AnnotationEntity) {
        const before = this.#require(id);
        if (before.deleted) throw new Error(`Annotation ${id} is deleted`);
        const candidate = update(cloneEntity(before));
        if (candidate.identity.id !== id || candidate.pageIndex !== before.pageIndex) {
            throw new Error('Annotation identity and pageIndex are immutable');
        }
        const after = {
            ...candidate,
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#commit({
            before: cloneEntity(before),
            after,
        });
        return cloneEntity(after);
    }

    #commit(entry: IHistoryEntry) {
        const id = (entry.before ?? entry.after)?.identity.id;
        if (!id) {
            throw new Error('History entry has no annotation identity');
        }
        const apply = (value: AnnotationEntity | null) => {
            if (value) this.#entities.set(id, cloneEntity(value));
            else this.#entities.delete(id);
            this.#mutationEpoch += 1;
            this.#emit();
        };
        apply(entry.after);
        this.#history.registerCommand({
            cmd: () => apply(entry.after),
            undo: () => apply(entry.before),
        });
    }

    #commitBatch(entries: readonly IHistoryEntry[]) {
        const apply = (side: 'before' | 'after') => {
            const ordered = side === 'before' ? [...entries].reverse() : entries;
            ordered.forEach((entry) => {
                const value = entry[side];
                const id = (entry.before ?? entry.after)?.identity.id;
                if (!id) {
                    throw new Error('History entry has no annotation identity');
                }
                if (value) this.#entities.set(id, cloneEntity(value));
                else this.#entities.delete(id);
            });
            this.#mutationEpoch += 1;
            this.#emit();
        };
        apply('after');
        this.#history.registerCommand({
            cmd: () => apply('after'),
            undo: () => apply('before'),
        });
    }

    #require(id: AnnotationId) {
        const entity = this.#entities.get(id);
        if (!entity) throw new Error(`Unknown annotation ${id}`);
        return entity;
    }

    #applyImportedShapes(
        proposals: readonly IShapeImportProposal[],
        mode: TShapeApplyMode,
        frontier?: IAnnotationSaveFrontier,
    ) {
        const shapes = this.listShapes({includeDeleted: true});
        if (mode === 'replace') {
            this.forget(new Set(shapes.map(entity => entity.identity.id)));
            this.adoptEntitiesAsSavedBaseline(new Set(proposals.map(proposal => this.#importShape(proposal))));
            return;
        }

        const remaining = proposals.map(proposal => ({
            annotationId: proposal.annotationId,
            geometry: structuredClone(proposal.geometry),
        }));
        const adopted = new Set<AnnotationId>();
        shapes.filter(entity => !entity.deleted).forEach((entity) => {
            const index = findImportedShapeMatchIndex(entity.geometry, remaining.map(item => item.geometry));
            const [match] = index === -1 ? [] : remaining.splice(index, 1);
            if (!match) {
                return;
            }
            this.#adoptImportedGeometry(entity, match.geometry, mode, frontier);
            adopted.add(entity.identity.id);
        });

        const tombstones = shapes.filter(entity => entity.deleted);
        const survivingTombstones = mode === 'prime'
            ? tombstones
            : mode === 'adopt-self-saved'
                ? []
                : tombstones.filter(entity => proposals.some(
                    proposal => shapeStableRefsMatch(proposal.geometry, entity.geometry),
                ));
        // Unmatched embedded shapes are gone from the document; local drafts and
        // tombstones the scan still carries survive it. Priming removes nothing
        // at all: it runs against bytes whose save is not acknowledged yet, and
        // dropping a captured entity would break the save frontier.
        this.forget(mode === 'prime' ? new Set() : new Set([
            ...shapes
                .filter(entity => !entity.deleted
                    && !adopted.has(entity.identity.id)
                    && entity.geometry.source === 'embedded')
                .map(entity => entity.identity.id),
            ...tombstones
                .filter(entity => !survivingTombstones.includes(entity))
                .map(entity => entity.identity.id),
        ]));

        if (mode === 'prime') {
            return;
        }
        remaining
            .filter(item => !survivingTombstones.some(entity => shapeStableRefsMatch(item.geometry, entity.geometry)))
            .forEach(item => adopted.add(this.#importShape(item)));

        this.adoptEntitiesAsSavedBaseline(mode === 'adopt-self-saved'
            ? new Set(this.listShapes().map(entity => entity.identity.id))
            : adopted);
    }

    #adoptImportedGeometry(
        entity: IShapeEntity,
        imported: IShapeAnnotation,
        mode: TShapeApplyMode,
        frontier?: IAnnotationSaveFrontier,
    ) {
        if (mode === 'reconcile') {
            this.import({
                ...entity,
                identity: {
                    ...entity.identity,
                    ...(imported.annotationId ? {pdfRef: imported.annotationId} : {}),
                    ...(getNormalizedShapeStableKey(imported)
                        ? {pdfName: getNormalizedShapeStableKey(imported)!}
                        : {}),
                },
                geometry: {
                    ...imported,
                    id: entity.geometry.id,
                },
                revision: entity.revision + 1,
                persistedRevision: entity.revision + 1,
                modifiedAt: imported.modifiedAt ?? entity.modifiedAt,
            }, {preserveSavedBaseline: true});
            return;
        }
        // Saved-bytes scans only carry identity for shapes the user still owns;
        // adopting their geometry here would discard edits made while the save ran.
        this.#reconcilePersistedShapeIdentity(entity, imported, frontier);
    }

    #reconcilePersistedShapeIdentity(
        entity: IShapeEntity,
        imported: IShapeEntity['geometry'],
        frontier?: IAnnotationSaveFrontier,
    ) {
        const stableKey = getNormalizedShapeStableKey(imported);
        const identity = {
            ...entity.identity,
            ...(imported.annotationId ? {pdfRef: imported.annotationId} : {}),
            ...(stableKey ? {pdfName: stableKey} : {}),
        };
        const persistedRevision = Math.max(entity.persistedRevision, 0);
        const frontierState = frontier ? this.#saveFrontiers.get(frontier) : undefined;
        const previousPreparation = frontierState?.preparedChanges.get(entity.identity.id);
        if (frontierState) {
            frontierState.preparedChanges.set(entity.identity.id, {
                beforeIdentity: previousPreparation?.beforeIdentity ?? structuredClone(entity.identity),
                afterIdentity: structuredClone(identity),
                beforePersistedRevision: previousPreparation?.beforePersistedRevision ?? entity.persistedRevision,
                afterPersistedRevision: persistedRevision,
            });
        }
        this.#identities.bind(identity);
        this.#entities.set(entity.identity.id, {
            ...entity,
            identity,
            persistedRevision,
        });
        this.#mutationEpoch += 1;
        this.#emit();
    }

    #importShape(proposal: IShapeImportProposal) {
        const shape = proposal.geometry;
        const stableKey = getNormalizedShapeStableKey(shape);
        this.import({
            kind: 'shape',
            identity: {
                id: proposal.annotationId,
                ...(shape.annotationId ? {pdfRef: shape.annotationId} : {}),
                ...(stableKey ? {pdfName: stableKey} : {}),
                ...(shape.id ? {elementId: shape.id} : {}),
            },
            pageIndex: shape.pageIndex,
            revision: 0,
            persistedRevision: 0,
            deleted: false,
            createdAt: shape.createdAt ?? null,
            modifiedAt: shape.modifiedAt ?? null,
            author: null,
            geometry: structuredClone(shape),
        }, {preserveSavedBaseline: true});
        return proposal.annotationId;
    }

    #requireShape(id: AnnotationId, geometry: IShapeEntity['geometry']) {
        const entity = this.#require(id);
        if (entity.kind !== 'shape') throw new Error(`Annotation ${id} is not a shape`);
        if (geometry.id !== entity.geometry.id || geometry.pageIndex !== entity.pageIndex) {
            throw new Error('Shape identity and pageIndex are immutable');
        }
        return entity;
    }

    #rebindIdentities() {
        this.#identities.clear();
        this.#entities.forEach(entity => this.#identities.bind(entity.identity));
    }

    #externalIdentityKeys(identity: AnnotationEntity['identity']) {
        return Array.from(this.#markupSubtypeAliases([
            identity.pdfRef,
            identity.pdfName,
            identity.pdfjsUid,
            identity.elementId,
        ].filter((value): value is string => Boolean(value))));
    }

    #markupSubtypeAliases(externalIds: readonly string[]) {
        const aliases = new Set<string>();
        externalIds.filter(Boolean).forEach((externalId) => {
            aliases.add(externalId);
            const normalized = normalizePdfJsAnnotationId(externalId);
            if (normalized) {
                aliases.add(normalized);
            }
        });
        return aliases;
    }

    #findPendingMarkupSubtype(externalIds: readonly string[]) {
        for (const alias of this.#markupSubtypeAliases(externalIds)) {
            const intent = this.#pendingMarkupSubtypes.get(alias);
            if (intent) {
                return intent;
            }
        }
        return null;
    }

    #forgetPendingMarkupSubtype(intent: IPendingMarkupSubtypeIntent) {
        intent.aliases.forEach((alias) => {
            if (this.#pendingMarkupSubtypes.get(alias) === intent) {
                this.#pendingMarkupSubtypes.delete(alias);
            }
        });
    }

    #conditionallyRestoreIdentity(
        current: AnnotationEntity['identity'],
        before: AnnotationEntity['identity'],
        prepared: AnnotationEntity['identity'],
    ) {
        let changed = false;
        const restored = {...current};
        ([
            'pdfRef',
            'pdfName',
            'pdfjsUid',
            'elementId',
        ] as const).forEach((key) => {
            if (current[key] !== prepared[key]) {
                return;
            }
            Object.assign(restored, {[key]: before[key]});
            changed = changed || restored[key] !== current[key];
        });
        return changed ? restored : current;
    }

    #emit() {
        const snapshot = this.list();
        this.#listeners.forEach(listener => listener(snapshot));
    }
}
