import { spawn } from "node:child_process";
import { extname, isAbsolute, relative, sep } from "node:path";
import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type ExtensionAPI,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types — same structures as original, but no global "active" state.
// Instead a Map caches per-host resolved working directories.
// ---------------------------------------------------------------------------

type SshExecOptions = {
  stdin?: string | Buffer;
  signal?: AbortSignal;
  onStdoutData?: (data: Buffer) => void;
  onStderrData?: (data: Buffer) => void;
  timeoutSeconds?: number;
};

// ---------------------------------------------------------------------------
// Shell quoting — prevents injection in SSH command strings
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// Path helpers — same safety checks as original
// ---------------------------------------------------------------------------

function normalizeRemoteDir(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Convert an absolute remote path to a relative one (within remoteCwd). Throws if outside. */
function remoteRelativePath(absolutePath: string, remoteCwd: string): string {
  const cwd = normalizeRemoteDir(remoteCwd);
  if (absolutePath === cwd) return ".";
  if (!absolutePath.startsWith(`${cwd}/`)) {
    throw new Error(
      `Path ${absolutePath} is outside the SSH working directory ${cwd}. Use a relative path.`,
    );
  }
  return absolutePath.slice(cwd.length + 1);
}

/** Map the remote path the LLM gave us into a local-relative form the edit tool understands. */
function toLocalEditPath(path: string, remoteCwd: string): string {
  if (path.startsWith("~/")) {
    throw new Error("ssh-edit does not expand ~ paths. Use a relative path instead.");
  }
  if (isAbsolute(path)) {
    return remoteRelativePath(path, remoteCwd);
  }
  return path;
}

/** Convert a local-workspace path back to an absolute remote path. Guards against traversal. */
function toRemotePath(localPath: string, localCwd: string, remoteCwd: string): string {
  const rel = relative(localCwd, localPath).split(sep).join("/");
  if (rel.startsWith("../") || rel === "..") {
    throw new Error(`Resolved path ${localPath} escaped the local SSH edit workspace.`);
  }
  if (!rel || rel === ".") {
    return remoteCwd;
  }
  return `${normalizeRemoteDir(remoteCwd)}/${rel}`;
}

/** Ext-based image mime type detection (same as original). */
function inferImageMimeType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// SSH execution — identical to original
// ---------------------------------------------------------------------------

function sshExec(
  remote: string,
  command: string,
  options: SshExecOptions = {},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [remote, command], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer =
      typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutSeconds * 1000)
        : undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => child.kill();

    child.stdout.on("data", (data: Buffer) => {
      stdoutChunks.push(data);
      options.onStdoutData?.(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
      options.onStderrData?.(data);
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      cleanup();
      if (options.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout:${options.timeoutSeconds}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode,
      });
    });

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

/** Like sshExec but throws on non-zero exit. */
async function sshOk(remote: string, command: string, options: SshExecOptions = {}): Promise<Buffer> {
  const { stdout, stderr, exitCode } = await sshExec(remote, command, options);
  if (exitCode !== 0) {
    const errorText = stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || "unknown ssh error";
    throw new Error(`SSH failed (${exitCode}) on ${remote}: ${errorText}`);
  }
  return stdout;
}

// ---------------------------------------------------------------------------
// Per-host CWD cache — resolved once, reused across calls
// ---------------------------------------------------------------------------

const remoteCwdCache = new Map<string, string>();

async function resolveHostCwd(host: string): Promise<string> {
  const cached = remoteCwdCache.get(host);
  if (cached) return cached;
  const cwd = (await sshOk(host, "pwd")).toString("utf8").trim();
  remoteCwdCache.set(host, cwd);
  return cwd;
}

// ---------------------------------------------------------------------------
// Operations factories — same as original but take (host, remoteCwd)
// ---------------------------------------------------------------------------

function createRemoteReadOps(host: string, remoteCwd: string): ReadOperations {
  return {
    readFile: (absolutePath) => sshOk(host, `cat ${shellQuote(absolutePath)}`),
    access: (absolutePath) =>
      sshOk(host, `test -r ${shellQuote(absolutePath)}`).then(() => {}),
    detectImageMimeType: async (absolutePath) => inferImageMimeType(absolutePath),
  };
}

function createRemoteWriteOps(host: string, remoteCwd: string): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      await sshOk(host, `cat > ${shellQuote(absolutePath)}`, { stdin: content });
    },
    mkdir: (dir) => sshOk(host, `mkdir -p ${shellQuote(dir)}`).then(() => {}),
  };
}

function createRemoteEditOps(
  host: string,
  remoteCwd: string,
  localCwd: string,
): EditOperations {
  const remotePath = (path: string) => toRemotePath(path, localCwd, remoteCwd);
  return {
    readFile: (absolutePath) =>
      sshOk(host, `cat ${shellQuote(remotePath(absolutePath))}`),
    writeFile: async (absolutePath, content) => {
      await sshOk(host, `cat > ${shellQuote(remotePath(absolutePath))}`, {
        stdin: content,
      });
    },
    access: (absolutePath) => {
      const p = remotePath(absolutePath);
      return sshOk(host, `test -r ${shellQuote(p)} && test -w ${shellQuote(p)}`).then(() => {});
    },
  };
}

function createRemoteBashOps(host: string, remoteCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const script = `cd ${shellQuote(cwd)}\n${command}\n`;
      const { exitCode } = await sshExec(host, "exec bash -se", {
        stdin: script,
        signal,
        timeoutSeconds: timeout,
        onStdoutData: onData,
        onStderrData: onData,
      });
      return { exitCode };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared parameter: every tool gets a `host` field
// ---------------------------------------------------------------------------

const hostParam = Type.String({
  description:
    "SSH host to connect to. Must be a Host alias from ~/.ssh/config or a user@host string.",
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function sshRemoteExtension(pi: ExtensionAPI) {
  // Base definitions from pi's built-in tools (reused for parameters + rendering)
  const readBase = createReadToolDefinition("/");
  const writeBase = createWriteToolDefinition("/");
  const editBase = createEditToolDefinition("/");
  const bashBase = createBashToolDefinition("/");

  // ── remote_read ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ssh-read",
    label: "ssh-read",
    description:
      "Read a file on a remote host via SSH. Provide 'host' (SSH alias) and 'path' (absolute or relative to the remote home directory).",
    promptSnippet: "Read file contents on a remote SSH host",
    promptGuidelines: [
      "Use ssh-read when reading files on a remote host. Provide the SSH host alias.",
    ],
    parameters: Type.Object({
      host: hostParam,
      path: readBase.parameters.properties.path,
      offset: readBase.parameters.properties.offset,
      limit: readBase.parameters.properties.limit,
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const host = params.host as string;
      const remoteCwd = await resolveHostCwd(host);
      const tool = createReadToolDefinition(remoteCwd, {
        operations: createRemoteReadOps(host, remoteCwd),
      });
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      const path = typeof args?.path === "string" ? args.path : "???";
      const host = typeof args?.host === "string" ? args.host : "???";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ssh-read"))} ${theme.fg("accent", path)} ${theme.fg("muted", `@${host}`)}`,
        0,
        0,
      );
    },
    renderResult: readBase.renderResult,
  });

  // ── remote_write ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ssh-write",
    label: "ssh-write",
    description:
      "Write a file on a remote host via SSH. Provide 'host' (SSH alias), 'path', and 'content'. For full rewrites or new files.",
    promptSnippet: "Create or overwrite files on a remote SSH host",
    promptGuidelines: [
      "Use ssh-write for new files or full rewrites on a remote host. Provide the host alias.",
    ],
    parameters: Type.Object({
      host: hostParam,
      path: writeBase.parameters.properties.path,
      content: writeBase.parameters.properties.content,
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const host = params.host as string;
      const remoteCwd = await resolveHostCwd(host);
      const tool = createWriteToolDefinition(remoteCwd, {
        operations: createRemoteWriteOps(host, remoteCwd),
      });
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      const path = typeof args?.path === "string" ? args.path : "???";
      const host = typeof args?.host === "string" ? args.host : "???";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ssh-write"))} ${theme.fg("accent", path)} ${theme.fg("muted", `@${host}`)}`,
        0,
        0,
      );
    },
    renderResult: writeBase.renderResult,
  });

  // ── remote_edit ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ssh-edit",
    label: "ssh-edit",
    description:
      "Edit a file on a remote host via SSH using exact-text replacement. Provide 'host' (SSH alias), 'path', and 'edits' (array of {oldText, newText}).",
    promptSnippet: "Make precise file edits on a remote SSH host",
    promptGuidelines: [
      "Use ssh-edit for precise remote changes. Provide the SSH host alias.",
      "Each edits[].oldText must match exactly in the remote file.",
    ],
    parameters: Type.Object({
      host: hostParam,
      path: editBase.parameters.properties.path,
      edits: editBase.parameters.properties.edits,
    }),
    prepareArguments: editBase.prepareArguments
      ? (args: unknown) => ({ host: (args as any).host, ...editBase.prepareArguments!(args) })
      : undefined,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const host = params.host as string;
      const remoteCwd = await resolveHostCwd(host);
      const localCwd = process.cwd();
      const transformedParams = {
        ...params,
        path: toLocalEditPath(params.path as string, remoteCwd),
      };
      const tool = createEditToolDefinition(localCwd, {
        operations: createRemoteEditOps(host, remoteCwd, localCwd),
      });
      return tool.execute(toolCallId, transformedParams, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      const path = typeof args?.path === "string" ? args.path : "???";
      const host = typeof args?.host === "string" ? args.host : "???";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ssh-edit"))} ${theme.fg("accent", path)} ${theme.fg("muted", `@${host}`)}`,
        0,
        0,
      );
    },
    renderResult: editBase.renderResult,
  });

  // ── remote_bash ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ssh-bash",
    label: "ssh-bash",
    description:
      "Execute a bash command on a remote host via SSH. Provide 'host' (SSH alias) and 'command'. Runs in the remote home directory.",
    promptSnippet: "Execute bash commands on a remote SSH host",
    promptGuidelines: [
      "Use ssh-bash when commands must run on a specific remote host. Provide the host alias.",
    ],
    parameters: Type.Object({
      host: hostParam,
      command: bashBase.parameters.properties.command,
      timeout: bashBase.parameters.properties.timeout,
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const host = params.host as string;
      const remoteCwd = await resolveHostCwd(host);
      const tool = createBashToolDefinition(remoteCwd, {
        operations: createRemoteBashOps(host, remoteCwd),
      });
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const command = typeof args?.command === "string" ? args.command : "???";
      const host = typeof args?.host === "string" ? args.host : "???";
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("ssh-bash"))} ${theme.fg("accent", command)} ${theme.fg("muted", `@${host}`)}`,
      );
      return text;
    },
    renderResult: bashBase.renderResult,
  });
}
