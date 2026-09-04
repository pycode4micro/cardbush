import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
} from "node:path";

export type TerminalCommandShell = "cmd" | "powershell" | "posix";

export interface ProtectedTerminalDeletion {
  protection:
    | "filesystem_root"
    | "user_home"
    | "user_home_sibling"
    | "project_root";
  target: string;
  message: string;
}

interface TerminalCommandSafetyInput {
  command: string;
  cwd: string;
  shell: TerminalCommandShell;
  projectRoots?: string[];
}

interface CommandToken {
  value: string;
  operator: boolean;
}

const deletionCommands = new Set([
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "rm",
  "rmdir",
]);

const commandPrefixes = new Set([
  "builtin",
  "command",
  "do",
  "else",
  "env",
  "exec",
  "nohup",
  "sudo",
  "then",
  "time",
  "!",
]);

const powershellOptionsWithValues = new Set([
  "credential",
  "debugvariable",
  "erroraction",
  "errorvariable",
  "exclude",
  "filter",
  "include",
  "informationaction",
  "informationvariable",
  "outbuffer",
  "outvariable",
  "pipelinevariable",
  "progressaction",
  "stream",
  "verbosevariable",
  "warningaction",
  "warningvariable",
]);

/**
 * Rejects only direct shell deletion commands that target invariant protected
 * directories. It is deliberately syntactic and deterministic: no task or
 * command intent is inferred, and safe targets never become permission asks.
 */
export function protectedTerminalDeletion(
  input: TerminalCommandSafetyInput,
): ProtectedTerminalDeletion | null {
  const segments = commandSegments(input.command);
  let currentDirectory = resolve(input.cwd);
  const directoryStack: string[] = [];
  for (const segment of segments) {
    const directoryChange = workingDirectoryChange(
      segment,
      input.shell,
      currentDirectory,
    );
    if (directoryChange?.kind === "push") {
      directoryStack.push(currentDirectory);
      currentDirectory = directoryChange.path;
      continue;
    }
    if (directoryChange?.kind === "set") {
      currentDirectory = directoryChange.path;
      continue;
    }
    if (directoryChange?.kind === "pop") {
      currentDirectory = directoryStack.pop() ?? currentDirectory;
      continue;
    }
    const invocation = deletionInvocation(segment, input.shell);
    if (!invocation) continue;
    for (const candidate of deletionTargets(invocation.args, invocation.shell)) {
      const target = resolveDeletionTarget(candidate, currentDirectory);
      if (!target) continue;
      const protection = protectedTarget(target, input.projectRoots ?? []);
      if (!protection) continue;
      return {
        protection,
        target,
        message: protectedDeletionMessage(protection, target),
      };
    }
  }
  return null;
}

function workingDirectoryChange(
  segment: CommandToken[],
  shell: TerminalCommandShell,
  cwd: string,
): { kind: "set" | "push"; path: string } | { kind: "pop" } | null {
  const values = segment.map((token) => token.value).filter(Boolean);
  const command = normalizedCommand(values[0] ?? "");
  if (command === "popd" || command === "pop-location") return { kind: "pop" };
  const kind = ["pushd", "push-location"].includes(command)
    ? "push"
    : ["cd", "chdir", "set-location", "sl"].includes(command)
      ? "set"
      : null;
  if (!kind) return null;
  const target = deletionTargets(values.slice(1), shell)[0] ?? homedir();
  const resolvedPath = resolveDeletionTarget(target, cwd);
  return resolvedPath ? { kind, path: resolvedPath } : null;
}

function commandSegments(command: string): CommandToken[][] {
  const tokens = tokenize(command);
  const segments: CommandToken[][] = [];
  let segment: CommandToken[] = [];
  for (const token of tokens) {
    if (token.operator) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
      continue;
    }
    segment.push(token);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function tokenize(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let value = "";
  let quote = "";
  const flush = () => {
    if (!value) return;
    tokens.push({ value, operator: false });
    value = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) {
        if (quote === "'" && command[index + 1] === "'") {
          value += character;
          index += 1;
        } else {
          quote = "";
        }
      } else {
        value += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      if (character === "\n" || character === "\r") {
        tokens.push({ value: character, operator: true });
      }
      continue;
    }
    if (";&|{}<>()".includes(character)) {
      flush();
      while (command[index + 1] === character) index += 1;
      tokens.push({ value: character, operator: true });
      continue;
    }
    value += character;
  }
  flush();
  return tokens;
}

function deletionInvocation(
  segment: CommandToken[],
  shell: TerminalCommandShell,
): { args: string[]; shell: TerminalCommandShell } | null {
  const values = segment.map((token) => token.value).filter(Boolean);
  let index = 0;
  while (index < values.length) {
    const value = normalizedCommand(values[index]!);
    if (commandPrefixes.has(value) || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(values[index]!)) {
      index += 1;
      continue;
    }
    break;
  }
  const command = normalizedCommand(values[index] ?? "");
  if (deletionCommands.has(command)) {
    return { args: values.slice(index + 1), shell };
  }

  const nested = nestedShellCommand(values.slice(index));
  if (!nested) return null;
  for (const nestedSegment of commandSegments(nested.command)) {
    const invocation = deletionInvocation(nestedSegment, nested.shell);
    if (invocation) return invocation;
  }
  return null;
}

function nestedShellCommand(
  values: string[],
): { command: string; shell: TerminalCommandShell } | null {
  const command = normalizedCommand(values[0] ?? "");
  if (command === "cmd" || command === "cmd.exe") {
    const index = values.findIndex((value) => /^\/(?:c|k)$/i.test(value));
    return index >= 0
      ? { command: values.slice(index + 1).join(" "), shell: "cmd" }
      : null;
  }
  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(command)) {
    const index = values.findIndex((value) => /^-(?:c|command)$/i.test(value));
    return index >= 0
      ? { command: values.slice(index + 1).join(" "), shell: "powershell" }
      : null;
  }
  if (["bash", "sh", "zsh"].includes(command)) {
    const index = values.findIndex((value) => value === "-c");
    return index >= 0
      ? { command: values.slice(index + 1).join(" "), shell: "posix" }
      : null;
  }
  return null;
}

function normalizedCommand(value: string): string {
  const normalized = value.trim().replace(/\.(?:exe|cmd)$/i, "").toLowerCase();
  return normalized.split(/[\\/]/).pop() ?? normalized;
}

function deletionTargets(args: string[], shell: TerminalCommandShell): string[] {
  const targets: string[] = [];
  let optionsEnded = false;
  let nextValue: "path" | "option" | null = null;
  for (const raw of args) {
    const value = raw.trim();
    if (!value) continue;
    if (nextValue) {
      if (nextValue === "path") addDeletionTargets(targets, value);
      nextValue = null;
      continue;
    }
    const powershellOptionMatch = shell === "powershell"
      ? /^-([a-z][a-z0-9]*)(?::(.*))?$/i.exec(value)
      : null;
    const powershellOption = powershellOptionMatch?.[1]?.toLowerCase();
    const inlineOptionValue = powershellOptionMatch?.[2];
    if (powershellOption === "literalpath" || powershellOption === "path") {
      if (inlineOptionValue) addDeletionTargets(targets, inlineOptionValue);
      else nextValue = "path";
      continue;
    }
    if (powershellOption && powershellOptionsWithValues.has(powershellOption)) {
      if (inlineOptionValue === undefined) nextValue = "option";
      continue;
    }
    if (value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && isDeletionOption(value, shell)) continue;
    addDeletionTargets(targets, value);
  }
  return targets;
}

function addDeletionTargets(targets: string[], value: string): void {
  for (const candidate of value.split(",")) {
    const normalized = candidate.trim();
    if (normalized) targets.push(normalized);
  }
}

function isDeletionOption(value: string, shell: TerminalCommandShell): boolean {
  if (shell === "cmd") return /^\/[a-z]+(?::.*)?$/i.test(value);
  return /^-[a-z][a-z0-9:-]*(?:=.*)?$/i.test(value);
}

function resolveDeletionTarget(value: string, cwd: string): string | null {
  let candidate = value
    .replace(/^Microsoft\.PowerShell\.Core\\FileSystem::/i, "")
    .replace(/^\\\\\?\\/, "")
    .trim();
  if (!candidate) return null;

  const home = resolve(homedir());
  const filesystemRoot = parse(home).root;
  const replacements: Array<[RegExp, string]> = [
    [/^~(?=$|[\\/])/, home],
    [/^\$(?:env:)?(?:home|userprofile)(?=$|[\\/])/i, home],
    [/^\$\{(?:env:)?(?:home|userprofile)\}(?=$|[\\/])/i, home],
    [/^%(?:home|userprofile)%(?=$|[\\/])/i, home],
    [/^\$env:homedrive\$env:homepath(?=$|[\\/])/i, home],
    [/^%homedrive%%homepath%(?=$|[\\/])/i, home],
    [/^\$env:systemdrive(?=$|[\\/])/i, filesystemRoot.replace(/[\\/]+$/, "")],
    [/^%systemdrive%(?=$|[\\/])/i, filesystemRoot.replace(/[\\/]+$/, "")],
  ];
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(candidate)) continue;
    candidate = candidate.replace(pattern, replacement);
    break;
  }

  const wildcardIndex = candidate.search(/[*?\[]/);
  if (wildcardIndex >= 0) {
    return null;
  }
  candidate = candidate.replace(/[\\/]+$/, (ending) =>
    candidate === parse(candidate).root ? ending : ""
  );
  if (!candidate) return null;
  return resolve(isAbsolute(candidate) ? candidate : resolve(cwd, candidate));
}

function protectedTarget(
  target: string,
  projectRoots: string[],
): ProtectedTerminalDeletion["protection"] | null {
  const home = resolve(homedir());
  const normalizedTarget = identity(target);
  if (normalizedTarget === identity(resolve(parse(target).root))) return "filesystem_root";
  if (sameOrAncestor(target, home)) return "user_home";

  const homeParent = dirname(home);
  const fromHomeParent = relative(homeParent, target);
  if (
    fromHomeParent &&
    !fromHomeParent.startsWith("..") &&
    !isAbsolute(fromHomeParent) &&
    !/[\\/]/.test(fromHomeParent) &&
    identity(target) !== identity(home)
  ) {
    return "user_home_sibling";
  }

  for (const projectRoot of projectRoots) {
    if (projectRoot.trim() && sameOrAncestor(target, resolve(projectRoot))) {
      return "project_root";
    }
  }
  return null;
}

function sameOrAncestor(candidate: string, protectedPath: string): boolean {
  const value = relative(resolve(candidate), resolve(protectedPath));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function identity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function protectedDeletionMessage(
  protection: ProtectedTerminalDeletion["protection"],
  target: string,
): string {
  const labels = {
    filesystem_root: "filesystem root",
    user_home: "user home directory",
    user_home_sibling: "directory adjacent to the user home",
    project_root: "protected project/workspace root",
  } as const;
  return `Deletion of the ${labels[protection]} is permanently denied: ${target}`;
}
