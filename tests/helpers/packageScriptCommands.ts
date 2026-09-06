export type TPackageScripts = Readonly<Record<string, string | undefined>>;

const PACKAGE_SCRIPT_ALIAS_PATTERN = /^pnpm run ([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)$/u;

export function resolvePackageScript(scripts: TPackageScripts, scriptName: string) {
    const visited = new Set<string>();
    let currentScriptName = scriptName;

    while (true) {
        if (visited.has(currentScriptName)) {
            throw new Error(`Package script alias cycle detected at ${currentScriptName}`);
        }
        visited.add(currentScriptName);

        const script = scripts[currentScriptName];
        if (!script) {
            throw new Error(`Missing package script: ${currentScriptName}`);
        }

        const alias = PACKAGE_SCRIPT_ALIAS_PATTERN.exec(script);
        if (!alias) {
            return script;
        }

        currentScriptName = alias[1]!;
    }
}

export function scriptCommands(scripts: TPackageScripts, scriptName: string) {
    return resolvePackageScript(scripts, scriptName)
        .split(/\s*&&\s*/u)
        .map(command => command.trim())
        .filter(Boolean);
}
