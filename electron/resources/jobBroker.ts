import {
    availableParallelism,
    totalmem,
} from 'os';
import { clamp } from 'es-toolkit/math';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_AGING_INTERVAL_MS = 5_000;

export const MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES: Readonly<IJobResourceVector> = {
    cpuTokens: 2,
    estimatedResidentBytes: 256 * MIB,
    nativeProcesses: 1,
    ioWeight: 4,
};

export type TJobBrokerPriority = 'visible' | 'foreground' | 'user' | 'background';

export interface IJobResourceVector {
    cpuTokens: number;
    estimatedResidentBytes: number;
    nativeProcesses: number;
    ioWeight: number;
}

export interface IJobBrokerRequest {
    ownerId: string;
    kind: string;
    priority: TJobBrokerPriority;
    resources: IJobResourceVector;
    perOwnerLimit?: number;
    signal?: AbortSignal;
}

export interface IJobBrokerLease {
    readonly token: string;
    readonly resources: IJobResourceVector;
    release: () => boolean;
}

interface IActiveJob extends IJobBrokerRequest {token: string;}

interface IQueuedJob {
    id: number;
    enqueuedAt: number;
    request: IJobBrokerRequest;
    resolve: (lease: IJobBrokerLease) => void;
    reject: (reason: Error) => void;
    removeAbortListener: () => void;
}

const PRIORITY_RANK: Record<TJobBrokerPriority, number> = {
    visible: 0,
    foreground: 1,
    user: 2,
    background: 3,
};

function addResources(left: IJobResourceVector, right: IJobResourceVector): IJobResourceVector {
    return {
        cpuTokens: left.cpuTokens + right.cpuTokens,
        estimatedResidentBytes: left.estimatedResidentBytes + right.estimatedResidentBytes,
        nativeProcesses: left.nativeProcesses + right.nativeProcesses,
        ioWeight: left.ioWeight + right.ioWeight,
    };
}

function isNonNegativeFinite(value: number) {
    return Number.isFinite(value) && value >= 0;
}

function validateResourceVector(resources: IJobResourceVector) {
    if (
        !isNonNegativeFinite(resources.cpuTokens)
        || !isNonNegativeFinite(resources.estimatedResidentBytes)
        || !isNonNegativeFinite(resources.nativeProcesses)
        || !isNonNegativeFinite(resources.ioWeight)
    ) {
        throw new TypeError('Job resource values must be non-negative finite numbers');
    }
}

function createAbortError(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The resource request was aborted.', 'AbortError');
}

export class JobBroker {
    private readonly active = new Map<string, IActiveJob>();
    private readonly queue: IQueuedJob[] = [];
    private counter = 0;

    constructor(
        private readonly capacity: IJobResourceVector,
        private readonly agingIntervalMs = DEFAULT_AGING_INTERVAL_MS,
        private readonly now: () => number = Date.now,
    ) {
        validateResourceVector(capacity);
    }

    acquire(request: IJobBrokerRequest): Promise<IJobBrokerLease> {
        validateResourceVector(request.resources);
        if (!this.fitsCapacity(request.resources)) {
            return Promise.reject(new RangeError(`Job ${request.kind} exceeds broker capacity`));
        }
        if (request.signal?.aborted) {
            return Promise.reject(createAbortError(request.signal));
        }
        return new Promise<IJobBrokerLease>((resolve, reject) => {
            const id = ++this.counter;
            const handleAbort = () => {
                const index = this.queue.findIndex(item => item.id === id);
                if (index < 0) {
                    return;
                }
                const [queued] = this.queue.splice(index, 1);
                queued?.removeAbortListener();
                reject(createAbortError(request.signal!));
            };
            request.signal?.addEventListener('abort', handleAbort, {once: true});
            this.queue.push({
                id,
                enqueuedAt: this.now(),
                request,
                resolve,
                reject,
                removeAbortListener: () => request.signal?.removeEventListener('abort', handleAbort),
            });
            this.dispatch();
        });
    }

    release(token: string) {
        if (!this.active.delete(token)) {
            return false;
        }
        this.dispatch();
        return true;
    }

    cancelOwner(ownerId: string, reason = `Resource requests canceled for owner ${ownerId}`) {
        for (let index = this.queue.length - 1; index >= 0; index -= 1) {
            const queued = this.queue[index];
            if (queued?.request.ownerId !== ownerId) {
                continue;
            }
            this.queue.splice(index, 1);
            queued.removeAbortListener();
            queued.reject(new Error(reason));
        }
    }

    getSnapshot() {
        return {
            capacity: {...this.capacity},
            active: this.active.size,
            queued: this.queue.length,
            used: this.getUsedResources(),
        };
    }

    private dispatch() {
        while (this.queue.length > 0) {
            const grantable = this.queue
                .map((item, index) => ({
                    item,
                    index,
                }))
                .filter(({item}) => this.canGrant(item.request))
                .sort((left, right) => this.compareQueued(left.item, right.item))[0];
            if (!grantable) {
                return;
            }
            const [next] = this.queue.splice(grantable.index, 1);
            if (!next) {
                return;
            }
            next.removeAbortListener();
            const token = `job-${next.id}`;
            this.active.set(token, {
                ...next.request,
                token,
            });
            let released = false;
            next.resolve({
                token,
                resources: {...next.request.resources},
                release: () => {
                    if (released) {
                        return false;
                    }
                    released = true;
                    return this.release(token);
                },
            });
        }
    }

    private compareQueued(left: IQueuedJob, right: IQueuedJob) {
        const leftRank = this.getEffectivePriorityRank(left);
        const rightRank = this.getEffectivePriorityRank(right);
        if (leftRank !== rightRank) {
            return leftRank - rightRank;
        }
        const leftOwnerLoad = this.getOwnerActiveCount(left.request.ownerId, left.request.kind);
        const rightOwnerLoad = this.getOwnerActiveCount(right.request.ownerId, right.request.kind);
        return leftOwnerLoad - rightOwnerLoad || left.id - right.id;
    }

    private getEffectivePriorityRank(item: IQueuedJob) {
        const ageSteps = this.agingIntervalMs > 0
            ? Math.floor(Math.max(0, this.now() - item.enqueuedAt) / this.agingIntervalMs)
            : 0;
        return Math.max(0, PRIORITY_RANK[item.request.priority] - ageSteps);
    }

    private canGrant(request: IJobBrokerRequest) {
        if (
            request.perOwnerLimit !== undefined
            && this.getOwnerActiveCount(request.ownerId, request.kind) >= request.perOwnerLimit
        ) {
            return false;
        }
        const proposed = addResources(this.getUsedResources(), request.resources);
        return this.fitsCapacity(proposed);
    }

    private fitsCapacity(resources: IJobResourceVector) {
        return resources.cpuTokens <= this.capacity.cpuTokens
            && resources.estimatedResidentBytes <= this.capacity.estimatedResidentBytes
            && resources.nativeProcesses <= this.capacity.nativeProcesses
            && resources.ioWeight <= this.capacity.ioWeight;
    }

    private getOwnerActiveCount(ownerId: string, kind: string) {
        return Array.from(this.active.values())
            .filter(active => active.ownerId === ownerId && active.kind === kind)
            .length;
    }

    private getUsedResources() {
        return Array.from(this.active.values()).reduce(
            (total, active) => addResources(total, active.resources),
            {
                cpuTokens: 0,
                estimatedResidentBytes: 0,
                nativeProcesses: 0,
                ioWeight: 0,
            },
        );
    }
}

export function resolveMainJobBrokerCapacity(
    availableCpuCount = availableParallelism(),
    hostMemoryBytes = totalmem(),
): IJobResourceVector {
    const cpuCount = Math.max(1, availableCpuCount);
    const totalMemoryBytes = Math.max(0, hostMemoryBytes);
    const freeReserveBytes = clamp(totalMemoryBytes * 0.15, GIB, 4 * GIB);
    return {
        cpuTokens: clamp(Math.floor(cpuCount * 0.75), MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.cpuTokens, 16),
        estimatedResidentBytes: Math.max(
            MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.estimatedResidentBytes,
            totalMemoryBytes - freeReserveBytes,
        ),
        nativeProcesses: clamp(
            Math.floor(cpuCount / 2),
            MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.nativeProcesses,
            8,
        ),
        // A weight of four is used by supported single-process save and
        // fingerprint jobs. Keep that work admissible on low-core hosts while
        // still allowing additional I/O concurrency on larger machines.
        ioWeight: clamp(Math.floor(cpuCount / 2), MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.ioWeight, 8),
    };
}

export const mainJobBroker = new JobBroker(resolveMainJobBrokerCapacity());
