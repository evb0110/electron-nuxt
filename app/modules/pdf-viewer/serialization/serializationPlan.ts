import type {
    AnnotationEntity,
    AnnotationId,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import type { IAnnotationSaveFrontier } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {TAnnotationMutationOperation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
export type {TAnnotationMutationOperation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';

export type TSerializationBackend = 'native-append' | 'pdfjs-save-document' | 'pdf-lib-rewrite';
export type TSaveMutationPhase =
    | 'page-tree'
    | 'metadata'
    | 'ocr'
    | 'annotations'
    | 'postconditions';

/** Route-independent semantic order. Backends may change mechanism, never ordering. */
const SAVE_MUTATION_ORDER: readonly TSaveMutationPhase[] = Object.freeze([
    'page-tree',
    'metadata',
    'ocr',
    'annotations',
    'postconditions',
]);

export interface ISerializationPageOperation {
    readonly operation: 'rotate' | 'delete' | 'insert' | 'reorder' | 'crop' | 'remove-crop';
    readonly pageIndexes: readonly number[];
    readonly fields: Readonly<Record<string, unknown>>;
}

export interface ISerializationMetadataPlan {
    readonly pageLabels: readonly IPdfPageLabelRange[] | null;
    readonly bookmarks: readonly IPdfBookmarkEntry[] | null;
}

export interface ISerializationOcrOperation {
    readonly pageIndex: number;
    readonly operation: 'replace-text-layer' | 'remove-text-layer';
    readonly payloadHash: string;
}

export interface ISerializationRouteConstraints {
    readonly allowedBackends: readonly TSerializationBackend[];
    readonly forceRewrite: boolean;
    readonly preserveLoadedSource: boolean;
}

export interface ISerializationPostconditions {
    readonly expectedPageCount: number | null;
    readonly requireValidXref: boolean;
    readonly requireAnnotationSemanticMatch: boolean;
    readonly changedObjectRefs: readonly string[];
}

export interface ISerializationPlanInputs {
    readonly pageOperations?: readonly ISerializationPageOperation[];
    readonly metadata?: Partial<ISerializationMetadataPlan>;
    readonly ocrOperations?: readonly ISerializationOcrOperation[];
    readonly routeConstraints?: Partial<ISerializationRouteConstraints>;
    readonly postconditions?: Partial<ISerializationPostconditions>;
}

/** The sole canonical mutation order shared by every serialization backend. */
export const SERIALIZATION_MUTATION_ORDER: readonly TAnnotationMutationOperation[] = [
    'prepare-free-text-appearance',
    'write-free-text-contents',
    'write-text-markup',
    'write-shape',
    'delete-annotation',
    'bind-identities',
];

export interface IAnnotationMutationStep {
    readonly id: string;
    readonly annotationId: AnnotationId;
    readonly operation: TAnnotationMutationOperation;
    readonly dependsOn: readonly string[];
    readonly fields: Readonly<Record<string, unknown>>;
}

export interface ISerializationPlan<TBackendProjection = never> {
    readonly frontier: IAnnotationSaveFrontier;
    readonly sourceRevision: IAnnotationSaveFrontier['documentRevisionToken'];
    readonly sourceEpoch: number;
    readonly entityBaselineHash: string;
    readonly mutationOrder: readonly TSaveMutationPhase[];
    readonly pageOperations: readonly ISerializationPageOperation[];
    readonly metadata: ISerializationMetadataPlan;
    readonly ocrOperations: readonly ISerializationOcrOperation[];
    readonly routeConstraints: ISerializationRouteConstraints;
    readonly postconditions: ISerializationPostconditions;
    /** Immutable mechanism-specific projection captured only after the semantic plan is complete. */
    readonly backendProjection: TBackendProjection | null;
    readonly steps: readonly IAnnotationMutationStep[];
    readonly expected: readonly AnnotationEntity[];
    readonly entities: readonly AnnotationEntity[];
    readonly changedObjectRefs: readonly string[];
}

const MAX_TARGETED_OBJECT_REFS = 128;
const CANONICAL_OBJECT_REF = /(?:^|\D)(\d+)\s+(\d+)\s+R(?:$|\D)/iu;
const COMPACT_OBJECT_REF = /(?:^|\D)(\d+)R(\d+)?(?:$|\D)/iu;

function cloneSerializable<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeObjectRef(value: string | null | undefined) {
    if (!value) {
        return null;
    }
    const canonical = CANONICAL_OBJECT_REF.exec(value.trim());
    const compact = canonical ? null : COMPACT_OBJECT_REF.exec(value.trim());
    const objectNumber = Number(canonical?.[1] ?? compact?.[1]);
    const generationNumber = Number(canonical?.[2] ?? compact?.[2] ?? 0);
    if (
        !Number.isSafeInteger(objectNumber)
        || !Number.isSafeInteger(generationNumber)
        || objectNumber < 1
        || generationNumber < 0
    ) {
        return null;
    }
    return `${objectNumber} ${generationNumber} R`;
}

function collectChangedObjectRefs(entities: readonly AnnotationEntity[]) {
    const refs = new Set<string>();
    entities.forEach((entity) => {
        if (entity.deleted || refs.size >= MAX_TARGETED_OBJECT_REFS) {
            return;
        }
        const ref = normalizeObjectRef(entity.identity.pdfRef);
        if (ref) {
            refs.add(ref);
        }
    });
    return Object.freeze([...refs]);
}

const FIELDS = {
    'sticky-note': [
        'text',
        'anchor',
        'color',
        'author',
        'createdAt',
        'modifiedAt',
        'fidelity',
    ],
    'text-markup': [
        'subtype',
        'text',
        'geometry',
        'color',
        'opacity',
        'author',
        'createdAt',
        'modifiedAt',
        'fidelity',
    ],
    shape: [
        'geometry',
        'author',
        'createdAt',
        'modifiedAt',
        'fidelity',
    ],
} as const;

function allowedFields(entity: AnnotationEntity) {
    return Object.fromEntries(FIELDS[entity.kind].map(field => [
        field,
        Reflect.get(entity, field),
    ]));
}

export function buildSerializationPlan(
    frontier: IAnnotationSaveFrontier,
    dirty: readonly AnnotationEntity[],
    entities: readonly AnnotationEntity[] = dirty,
    inputs: ISerializationPlanInputs = {},
): ISerializationPlan {
    const steps: IAnnotationMutationStep[] = [];
    const knownPdfRefs = entities
        .map(entity => entity.identity.pdfRef)
        .filter((value): value is string => Boolean(value));
    dirty.forEach((entity) => {
        const prefix = entity.identity.id;
        if (entity.deleted) {
            steps.push({
                id: `${prefix}:delete`,
                annotationId: entity.identity.id,
                operation: 'delete-annotation',
                dependsOn: [],
                fields: {
                    identity: entity.identity,
                    pageIndex: entity.pageIndex,
                    kind: entity.kind,
                },
            });
            return;
        }
        if (entity.kind === 'sticky-note') {
            const prepareId = `${prefix}:prepare-free-text`;
            steps.push({
                id: prepareId,
                annotationId: entity.identity.id,
                operation: 'prepare-free-text-appearance',
                dependsOn: [],
                fields: {anchor: entity.anchor},
            });
            steps.push({
                id: `${prefix}:contents`,
                annotationId: entity.identity.id,
                operation: 'write-free-text-contents',
                dependsOn: [prepareId],
                fields: allowedFields(entity),
            });
        } else {
            steps.push({
                id: `${prefix}:write`,
                annotationId: entity.identity.id,
                operation: entity.kind === 'shape' ? 'write-shape' : 'write-text-markup',
                dependsOn: [],
                fields: allowedFields(entity),
            });
        }
        steps.push({
            id: `${prefix}:bind`,
            annotationId: entity.identity.id,
            operation: 'bind-identities',
            dependsOn: steps.filter(step => step.annotationId === entity.identity.id).map(step => step.id),
            fields: {
                identity: entity.identity,
                pageIndex: entity.pageIndex,
                kind: entity.kind,
                ...(entity.kind === 'text-markup' ? {subtype: entity.subtype} : {}),
                knownPdfRefs,
            },
        });
    });
    assertValidAnnotationSerializationPlan(steps);
    const mutationOrder = new Map(SERIALIZATION_MUTATION_ORDER.map((operation, index) => [
        operation,
        index,
    ]));
    steps.sort((left, right) => (
        (mutationOrder.get(left.operation) ?? Number.MAX_SAFE_INTEGER)
        - (mutationOrder.get(right.operation) ?? Number.MAX_SAFE_INTEGER)
    ));
    const expected = dirty.map(entity => Object.freeze(structuredClone(entity)));
    const canonicalEntities = entities.map(entity => Object.freeze(structuredClone(entity)));
    const changedObjectRefs = collectChangedObjectRefs(expected);
    const pageOperations = inputs.pageOperations?.map(operation => Object.freeze(cloneSerializable(operation))) ?? [];
    const ocrOperations = inputs.ocrOperations?.map(operation => Object.freeze(cloneSerializable(operation))) ?? [];
    const allowedBackends = inputs.routeConstraints?.allowedBackends
        ? [...inputs.routeConstraints.allowedBackends]
        : [
            'native-append',
            'pdfjs-save-document',
            'pdf-lib-rewrite',
        ] satisfies TSerializationBackend[];
    const metadata = Object.freeze({
        pageLabels: inputs.metadata?.pageLabels ? Object.freeze(cloneSerializable(inputs.metadata.pageLabels)) : null,
        bookmarks: inputs.metadata?.bookmarks ? Object.freeze(cloneSerializable(inputs.metadata.bookmarks)) : null,
    });
    const postconditions = Object.freeze({
        expectedPageCount: inputs.postconditions?.expectedPageCount ?? null,
        requireValidXref: inputs.postconditions?.requireValidXref ?? true,
        requireAnnotationSemanticMatch: inputs.postconditions?.requireAnnotationSemanticMatch ?? expected.length > 0,
        changedObjectRefs: Object.freeze([...(inputs.postconditions?.changedObjectRefs ?? changedObjectRefs)]),
    });
    return Object.freeze({
        frontier,
        sourceRevision: frontier.documentRevisionToken,
        sourceEpoch: frontier.epoch,
        entityBaselineHash: frontier.entityBaselineHash,
        mutationOrder: SAVE_MUTATION_ORDER,
        pageOperations: Object.freeze(pageOperations),
        metadata,
        ocrOperations: Object.freeze(ocrOperations),
        routeConstraints: Object.freeze({
            allowedBackends: Object.freeze(allowedBackends),
            forceRewrite: inputs.routeConstraints?.forceRewrite ?? false,
            preserveLoadedSource: inputs.routeConstraints?.preserveLoadedSource ?? false,
        }),
        postconditions,
        backendProjection: null,
        steps: Object.freeze(steps),
        expected: Object.freeze(expected),
        entities: Object.freeze(canonicalEntities),
        changedObjectRefs: postconditions.changedObjectRefs,
    });
}

export function withSerializationBackendProjection<TBackendProjection>(
    plan: ISerializationPlan,
    projection: TBackendProjection,
): ISerializationPlan<TBackendProjection> & {readonly backendProjection: TBackendProjection} {
    return Object.freeze({
        ...plan,
        // Callers construct a detached DTO while completing the plan. Avoid
        // structuredClone here because Vue may wrap otherwise plain snapshots
        // in proxies that are deliberately not cloneable.
        backendProjection: Object.freeze(projection as object) as TBackendProjection,
    });
}

/** Deterministic route policy over one immutable plan. */
export function selectSerializationBackend(
    plan: ISerializationPlan,
    available: readonly TSerializationBackend[],
): TSerializationBackend {
    const supported = new Set(available);
    const allowed = plan.routeConstraints.allowedBackends.filter(backend => supported.has(backend));
    const selected = plan.routeConstraints.forceRewrite
        ? allowed.find(backend => backend === 'pdf-lib-rewrite')
        : allowed[0];
    if (!selected) throw new Error('No serialization backend satisfies the immutable plan constraints');
    return selected;
}

function assertValidAnnotationSerializationPlan(steps: readonly IAnnotationMutationStep[]) {
    const ids = new Set(steps.map(step => step.id));
    steps.forEach((step) => {
        step.dependsOn.forEach((dependency) => {
            if (!ids.has(dependency)) throw new Error(`Missing annotation-plan dependency ${dependency}`);
        });
        if (step.operation === 'write-free-text-contents') {
            const hasPrepare = step.dependsOn.some(id => steps.find(candidate => candidate.id === id)?.operation === 'prepare-free-text-appearance');
            if (!hasPrepare) throw new Error('FreeText contents require a prepared blank appearance and point rect');
        }
    });
}

export interface IAnnotationReopenReader {reopen(bytes: Uint8Array): Promise<readonly AnnotationEntity[]>;}

export async function verifyAnnotationSave(
    bytes: Uint8Array,
    plan: ISerializationPlan,
    reader: IAnnotationReopenReader,
) {
    const actual = await reader.reopen(bytes);
    const byId = new Map(actual.map(entity => [
        entity.identity.id,
        entity,
    ]));
    const failures: string[] = [];
    const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
    const rectDiffers = (left: {
        left: number;
        top: number;
        width: number;
        height: number
    }, right: {
        left: number;
        top: number;
        width: number;
        height: number
    }) => (
        Math.abs(left.left - right.left) > 0.0001
        || Math.abs(left.top - right.top) > 0.0001
        || Math.abs(left.width - right.width) > 0.0001
        || Math.abs(left.height - right.height) > 0.0001
    );
    plan.expected.forEach((expected) => {
        const reopened = byId.get(expected.identity.id);
        if (expected.deleted) {
            if (reopened && !reopened.deleted) failures.push(`${expected.identity.id}: deletion absent`);
            return;
        }
        if (!reopened) {
            failures.push(`${expected.identity.id}: missing`);
            return;
        }
        if (reopened.kind !== expected.kind || reopened.pageIndex !== expected.pageIndex) {
            failures.push(`${expected.identity.id}: kind/page mismatch`);
        }
        const expectedBindings = expected.identity;
        if (
            (expectedBindings.pdfRef && reopened.identity.pdfRef !== expectedBindings.pdfRef)
            || (expectedBindings.pdfName && reopened.identity.pdfName !== expectedBindings.pdfName)
            || (expectedBindings.pdfjsUid && reopened.identity.pdfjsUid !== expectedBindings.pdfjsUid)
        ) {
            failures.push(`${expected.identity.id}: identity binding mismatch`);
        }
        if (expected.kind === 'sticky-note' && (reopened.kind !== 'sticky-note' || reopened.text !== expected.text)) {
            failures.push(`${expected.identity.id}: text mismatch`);
        }
        if (expected.kind === 'sticky-note' && reopened.kind === 'sticky-note' && rectDiffers(reopened.anchor, expected.anchor)) {
            failures.push(`${expected.identity.id}: anchor mismatch`);
        }
        if (expected.kind === 'text-markup' && (
            reopened.kind !== 'text-markup'
            || reopened.subtype !== expected.subtype
            || reopened.text !== expected.text
            || reopened.geometry.length !== expected.geometry.length
            || reopened.geometry.some((rect, index) => !expected.geometry[index] || rectDiffers(rect, expected.geometry[index]))
        )) {
            failures.push(`${expected.identity.id}: markup fidelity mismatch`);
        }
        if (expected.kind === 'shape' && (reopened.kind !== 'shape' || differs(reopened.geometry, expected.geometry))) {
            failures.push(`${expected.identity.id}: shape geometry mismatch`);
        }
    });
    if (failures.length) throw new Error(`Annotation reopen verification failed: ${failures.join('; ')}`);
}
