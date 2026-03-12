declare module 'semver' {
    export class SemVer {
        constructor(version: string, options?: unknown);
        raw: string;
        version: string;
        major: number;
        minor: number;
        patch: number;
        prerelease: Array<string | number>;
        build: string[];
        compare(other: string | SemVer): number;
        format(): string;
        toString(): string;
    }
}
