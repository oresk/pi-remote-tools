import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  type BashOperations,
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Remote file tools: pure-SSH implementations.
//
// Deliberately NOT delegating to pi's built-in read/write/edit tool bodies:
// those resolve paths against the LOCAL filesystem (realpath/access on the
// remote path), which fails with EACCES for paths like /root or /etc/pve.
// Here every byte travels over SSH; no remote path is ever touched locally.
//
// Transfers are base64 over stdin/stdout, so file content never passes
// through a shell: quotes, backticks, $, CRLF, heredoc markers are inert.
// ---------------------------------------------------------------------------

type SshExecOptions = {
  stdin?: string | Buffer;
  signal?: AbortSignal;
  onStdoutData?: (data: Buffer) => void;
  onStderrData?: (data: Buffer) => void;
  timeoutSeconds?: number;
};

type SshResult = { stdout: Buffer; stderr: Buffer; exitCode: number | null };
type HostInfo = { cwd: string; home: string; posixShell: boolean; bashAvailable: boolean };
type EditSpec = { oldText: string; newText: string; replaceAll?: boolean };

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50 * 1024;
const INLINE_READ_LIMIT = 1024 * 1024;

// ---------------------------------------------------------------------------
// Shell quoting — only ever applied to paths/values, never to file content
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// SSH execution
// ---------------------------------------------------------------------------

function sshExec(remote: string, command: string, options: SshExecOptions = {}): Promise<SshResult> {
  const { promise, resolve, reject } = Promise.withResolvers<SshResult>();
  const child = spawn("ssh", [remote, command], { stdio: ["pipe", "pipe", "pipe"] });
  {
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

    const onAbort = () => child.kill();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };

    child.stdout.on("error", () => {
      // Reader closed early; the exit code carries the real failure.
    });
    child.stderr.on("error", () => {});
    child.stdin.on("error", () => {
      // EPIPE when the remote exits before consuming stdin (auth failure,
      // immediate command failure). The close handler reports it properly.
    });
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
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), exitCode });
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
  }
  return promise;
}

/** Human-readable failure: exit code, stderr, and the command that produced it. */
function sshFailure(remote: string, command: string, result: SshResult): Error {
  const stderr = result.stderr.toString("utf8").trim();
  const stdout = result.stdout.toString("utf8").trim();
  const detail = stderr || stdout || "(no output)";
  const preview = command.replace(/\s*\n\s*/g, " ; ").slice(0, 200);
  return new Error(`ssh ${remote} exited ${result.exitCode ?? "signal"}: ${detail}\n  command: ${preview}`);
}

async function sshRaw(remote: string, command: string, options: SshExecOptions = {}): Promise<SshResult> {
  try {
    return await sshExec(remote, command, options);
  } catch (error) {
    throw new Error(`ssh ${remote} could not start: ${(error as Error).message}`);
  }
}

/** Like sshRaw but throws on non-zero exit. */
async function sshOk(remote: string, command: string, options: SshExecOptions = {}): Promise<Buffer> {
  const result = await sshRaw(remote, command, options);
  if (result.exitCode !== 0) throw sshFailure(remote, command, result);
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Per-host cwd/home, resolved once per process
// ---------------------------------------------------------------------------

const hostInfoCache = new Map<string, Promise<HostInfo>>();

function hostInfo(host: string): Promise<HostInfo> {
  let pending = hostInfoCache.get(host);
  if (!pending) {
    pending = (async () => {
      // `pwd`/`echo` are safe under any login shell; $PWD is not set under csh.
      const raw = await sshOk(host, `pwd; echo "$HOME"`).then((buffer) => buffer.toString("utf8"));
      const [cwd, home] = raw.split("\n");
      if (!cwd || !home) throw new Error(`Could not resolve remote cwd/home on ${host}`);
      // OPNsense-style hosts log in with csh/tcsh, where POSIX compound syntax fails.
      const probe = await sshRaw(host, "if true; then echo posix; fi");
      const posixShell = probe.exitCode === 0 && probe.stdout.toString("utf8").includes("posix");
      // OPNsense/FreeBSD hosts often ship no bash at all; ssh-bash falls back to POSIX sh.
      const bashAvailable = (await sshRaw(host, "bash -c 'exit 0'")).exitCode === 0;
      return { cwd: cwd.trim(), home: home.trim(), posixShell, bashAvailable };
    })();
    pending.catch(() => hostInfoCache.delete(host));
    hostInfoCache.set(host, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Path resolution.
//
// Absolute paths are used as-is: reachability is decided by the SSH user's
// own permissions, not by an artificial workspace root. Relative paths resolve
// against the remote home directory, `~` expands remotely.
// ---------------------------------------------------------------------------

function resolveRemotePath(path: string, info: HostInfo): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("A remote path is required");
  if (trimmed === "~") return info.home;
  if (trimmed.startsWith("~/")) return posix.normalize(posix.join(info.home, trimmed.slice(2)));
  if (posix.isAbsolute(trimmed)) return posix.normalize(trimmed);
  return posix.normalize(posix.join(info.cwd, trimmed));
}

// ---------------------------------------------------------------------------
// Remote FS primitives — all content is base64 over stdin/stdout
// ---------------------------------------------------------------------------

const recordKey = (host: string, path: string) => `${host}:${path}`;
const digestOf = (value: Buffer | string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

type RemoteFileInfo =
  | { kind: "file"; size: number; mode: string | null }
  | { kind: "dir" }
  | { kind: "missing" };

async function remoteFileInfo(host: string, absPath: string, posixShell: boolean): Promise<RemoteFileInfo> {
  const quoted = shellQuote(absPath);
  if (!posixShell) {
    // csh/tcsh: no `if/elif`, no `$()`, no `${x:-y}`. Simple commands only.
    if ((await sshRaw(host, `test -f ${quoted}`)).exitCode !== 0) {
      return (await sshRaw(host, `test -d ${quoted}`)).exitCode === 0 ? { kind: "dir" } : { kind: "missing" };
    }
    const size = await sshOk(host, `wc -c < ${quoted}`);
    const modeProbe = await sshRaw(host, `stat -f %Lp ${quoted}`);
    const mode = modeProbe.exitCode === 0 ? modeProbe.stdout.toString("utf8").trim() || null : null;
    return { kind: "file", size: Number.parseInt(size.toString("utf8").trim(), 10) || 0, mode };
  }
  const result = await sshRaw(
    host,
    `if [ -d ${quoted} ]; then printf 'dir\\n'; elif [ -f ${quoted} ]; then wc -c < ${quoted}; stat -c %a ${quoted} 2>/dev/null || stat -f %Lp ${quoted} 2>/dev/null || printf '?\\n'; else exit 44; fi`,
  );
  if (result.exitCode === 44) return { kind: "missing" };
  if (result.exitCode !== 0) throw sshFailure(host, `stat ${absPath}`, result);
  const [first, second] = result.stdout.toString("utf8").trim().split("\n");
  if (first === "dir") return { kind: "dir" };
  return {
    kind: "file",
    size: Number.parseInt(first ?? "0", 10) || 0,
    mode: second && second !== "?" ? second.trim() : null,
  };
}

/** Turn "not a file" into an actionable error instead of a vague ENOENT. */
function requireFile(info: RemoteFileInfo, host: string, absPath: string): { size: number; mode: string | null } {
  if (info.kind === "missing") throw new Error(`No such file on ${host}: ${absPath}`);
  if (info.kind === "dir") {
    throw new Error(`${absPath} is a directory on ${host} — read a file inside it, or list it with ssh-bash (ls ${absPath}).`);
  }
  return info;
}

async function readRemoteBytes(host: string, absPath: string): Promise<Buffer> {
  const stdout = await sshOk(host, `base64 < ${shellQuote(absPath)}`);
  return Buffer.from(stdout.toString("ascii").replace(/\s+/g, ""), "base64");
}

async function remoteLineCount(host: string, absPath: string): Promise<number> {
  const stdout = await sshOk(host, `wc -l < ${shellQuote(absPath)}`);
  return Number.parseInt(stdout.toString("utf8").trim(), 10) || 0;
}

/**
 * Atomic write: upload to a temp file in the target directory, then rename.
 * Preserves the destination's mode when it already exists (so executable
 * scripts stay executable), otherwise 644 under the remote umask.
 */
async function writeRemoteBytes(
  host: string,
  absPath: string,
  content: Buffer,
  posixShell: boolean,
): Promise<{ mode: string | null; bytes: number }> {
  const dir = posix.dirname(absPath);
  const payload = content.toString("base64");

  if (!posixShell) {
    // csh/tcsh path: each step is one simple command with quoted arguments.
    const tmp = `${dir}/.pi-ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    const existing = await remoteFileInfo(host, absPath, posixShell);
    await sshOk(host, `mkdir -p ${shellQuote(dir)}`);
    try {
      await sshOk(host, `base64 -d > ${shellQuote(tmp)}`, { stdin: payload });
      await sshOk(host, `chmod ${existing.kind === "file" && existing.mode ? existing.mode : "644"} ${shellQuote(tmp)}`);
      await sshOk(host, `mv -f ${shellQuote(tmp)} ${shellQuote(absPath)}`);
    } catch (error) {
      await sshRaw(host, `rm -f ${shellQuote(tmp)}`);
      throw error;
    }
    return { mode: existing.kind === "file" && existing.mode ? existing.mode : "644", bytes: content.length };
  }

  const script = [
    "set -e",
    `target=${shellQuote(absPath)}`,
    `mkdir -p ${shellQuote(dir)}`,
    `mode=$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || true)`,
    `tmp=$(mktemp "$(dirname "$target")/.pi-ssh.XXXXXX")`,
    `trap 'rm -f "$tmp"' EXIT`,
    `base64 -d > "$tmp"`,
    `if [ -n "$mode" ]; then chmod "$mode" "$tmp"; else chmod 644 "$tmp"; fi`,
    `mv -f "$tmp" "$target"`,
    `trap - EXIT`,
    `printf '%s' "\${mode:-644}"`,
  ].join("\n");
  const stdout = await sshOk(host, script, { stdin: payload });
  return { mode: stdout.toString("utf8").trim() || null, bytes: content.length };
}

// ---------------------------------------------------------------------------
// Serialize read-modify-write per remote path (parallel tool calls)
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

/** Digest of the last full read/write per path — used to detect drift. */
const lastSeen = new Map<string, { digest: string; size: number }>();

// ---------------------------------------------------------------------------
// Truncation + edit helpers
// ---------------------------------------------------------------------------

function truncateForModel(text: string): { text: string; truncated: boolean; shownLines: number; totalLines: number } {
  const allLines = text.split("\n");
  let shown = allLines.slice(0, READ_MAX_LINES);
  let truncated = shown.length < allLines.length;

  let output = shown.join("\n");
  if (Buffer.byteLength(output, "utf8") > READ_MAX_BYTES) {
    let cut = output.length;
    while (cut > 0 && Buffer.byteLength(output.slice(0, cut), "utf8") > READ_MAX_BYTES) {
      cut = Math.max(0, cut - 512);
    }
    output = output.slice(0, cut);
    truncated = true;
  }

  const shownLines = output.length === 0 ? 0 : output.split("\n").length;
  return { text: output, truncated, shownLines, totalLines: allLines.length };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

const normalizeCrlf = (value: string) => value.replace(/\r\n/g, "\n");
const normalizeTrailingWs = (value: string) =>
  normalizeCrlf(value)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");

/** Why an oldText failed to match: the usual suspects, checked explicitly. */
function explainMiss(content: string, oldText: string): string {
  const hints: string[] = [];
  const lines = content.split("\n");
  const firstLine = oldText.split("\n")[0]?.trim() ?? "";

  if (normalizeCrlf(content).includes(normalizeCrlf(oldText))) {
    hints.push("it matches once CRLF line endings are normalized");
  } else if (normalizeTrailingWs(content).includes(normalizeTrailingWs(oldText))) {
    hints.push("it matches after trailing whitespace is stripped (indentation differs)");
  }

  if (firstLine) {
    let bestLine = 0;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const score = commonPrefixLength(lines[i]?.trim() ?? "", firstLine);
      if (score > bestScore) {
        bestScore = score;
        bestLine = i + 1;
      }
    }
    if (bestLine > 0 && bestScore >= Math.max(3, Math.floor(firstLine.length * 0.4))) {
      hints.push(`closest line ${bestLine}: ${(lines[bestLine - 1] ?? "").trim().slice(0, 120)}`);
    }
  }

  hints.push(`the file has ${lines.length} lines`);
  if (lines.length <= 120) {
    const preview = lines
      .slice(0, 20)
      .map((line, index) => `${String(index + 1).padStart(4)}: ${line.slice(0, 110)}`)
      .join("\n");
    hints.push(`current content:\n${preview}${lines.length > 20 ? `\n   … ${lines.length - 20} more lines` : ""}`);
  } else {
    hints.push("re-read the region with ssh-read offset/limit before retrying");
  }

  return `Diagnostics: ${hints.join("; ")}.`;
}

function applyEdits(
  content: string,
  edits: EditSpec[],
  prefix: string,
): { next: string; summary: string[] } {
  let next = content;
  const summary: string[] = [];

  for (const [index, edit] of edits.entries()) {
    const { oldText, newText } = edit;
    if (!oldText) throw new Error(`${prefix}edits[${index}].oldText is empty`);

    const occurrences = next.split(oldText).length - 1;
    if (occurrences === 0) {
      const diagnostics = explainMiss(next, oldText);
      throw new Error(
        `${prefix}edits[${index}] not found in the remote file. ${diagnostics}`.trim(),
      );
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new Error(
        `${prefix}edits[${index}].oldText matches ${occurrences} times; include more surrounding context or set edits[${index}].replaceAll = true`,
      );
    }

    next = edit.replaceAll ? next.split(oldText).join(newText) : next.replace(oldText, newText);
    summary.push(`edits[${index}]: ${occurrences} replacement${occurrences === 1 ? "" : "s"}`);
  }

  return { next, summary };
}

function diffPreview(edits: EditSpec[], limit = 12): string {
  const rows: string[] = [];
  for (const edit of edits) {
    for (const line of edit.oldText.split("\n").slice(0, 3)) rows.push(`- ${line}`);
    for (const line of edit.newText.split("\n").slice(0, 3)) rows.push(`+ ${line}`);
    rows.push("~");
    if (rows.length >= limit) break;
  }
  return rows.slice(0, limit).join("\n");
}

// ---------------------------------------------------------------------------
// Parameters shared by the tools
// ---------------------------------------------------------------------------

const hostParam = Type.String({
  description:
    "SSH host to connect to. Must be a Host alias from ~/.ssh/config or a user@host string.",
});

const pathParam = Type.String({
  description:
    "File path on the remote host. Absolute paths are used as-is (any path the SSH user may access, e.g. /etc/pve/...). Relative paths resolve against the remote home directory. ~ is expanded.",
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function sshRemoteExtension(pi: ExtensionAPI) {
  const bashBase = createBashToolDefinition("/");

  // ── ssh-read ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ssh-read",
    label: "ssh-read",
    description:
      "Read a file on a remote host via SSH. Provide 'host' (SSH alias) and 'path' (absolute, or relative to the remote home directory).",
    promptSnippet: "Read file contents on a remote SSH host",
    promptGuidelines: [
      "Use ssh-read when reading files on a remote host. Provide the SSH host alias.",
      "ssh-read accepts absolute remote paths (e.g. /etc/pve/lxc/158.conf) — no need to make them relative.",
    ],
    parameters: Type.Object({
      host: hostParam,
      path: pathParam,
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-based)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const host = params.host as string;
      const info = await hostInfo(host);
      const absPath = resolveRemotePath(params.path as string, info);
      const offset = typeof params.offset === "number" ? Math.max(1, Math.trunc(params.offset)) : undefined;
      const limit = typeof params.limit === "number" ? Math.max(1, Math.trunc(params.limit)) : undefined;

      const stat = requireFile(await remoteFileInfo(host, absPath, info.posixShell), host, absPath);

      let body: string;
      let totalLines: number;
      let windowed = false;
      let windowStart = offset ?? 1;

      if (stat.size <= INLINE_READ_LIMIT) {
        const buffer = await readRemoteBytes(host, absPath);
        body = buffer.toString("utf8");
        lastSeen.set(recordKey(host, absPath), { digest: digestOf(buffer), size: buffer.length });

        const lines = body.split("\n");
        totalLines = lines.length;
        const startLine = (offset ?? 1) - 1;
        if (startLine >= lines.length) {
          throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
        }
        const endLine = limit !== undefined ? Math.min(startLine + limit, lines.length) : lines.length;
        body = lines.slice(startLine, endLine).join("\n");
        windowStart = startLine + 1;
        if (limit !== undefined && endLine < lines.length) {
          body += `\n\n[${lines.length - endLine} more lines in file. Use offset=${endLine + 1} to continue.]`;
        }
      } else {
        const start = offset ?? 1;
        const end = start + (limit ?? READ_MAX_LINES) - 1;
        body = (await sshOk(host, `sed -n '${start},${end}p' ${shellQuote(absPath)}`)).toString("utf8");
        totalLines = await remoteLineCount(host, absPath);
        windowed = true;
        windowStart = start;
      }

      const truncation = truncateForModel(body);
      let text = truncation.text;
      if (windowed) {
        const lastRequested = windowStart + (limit ?? READ_MAX_LINES) - 1;
        const shownEnd = Math.min(
          lastRequested,
          windowStart + Math.max(0, truncation.shownLines - 1),
          Math.max(totalLines - 1, windowStart),
        );
        if (shownEnd < totalLines) {
          text += `\n\n[Showing lines ${windowStart}-${shownEnd} of ${totalLines}. Use offset=${shownEnd + 1} to continue.]`;
        }
      } else if (truncation.truncated && limit === undefined) {
        const shownEnd = windowStart + Math.max(0, truncation.shownLines - 1);
        text += `\n\n[Showing lines ${windowStart}-${shownEnd} of ${totalLines}. Use offset=${shownEnd + 1} to continue.]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          host,
          path: absPath,
          bytes: stat.size,
          totalLines,
          mode: stat.mode,
          truncated: truncation.truncated || windowed,
        },
      };
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
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
      const details = result.details as { host?: string; path?: string; bytes?: number } | undefined;
      const content = result.content?.[0];
      const body = content && content.type === "text" ? content.text : "";
      const head = theme.fg(
        "muted",
        `${details?.path ?? ""}@${details?.host ?? ""} · ${details?.bytes ?? 0} bytes`,
      );
      const shown = body.split("\n").slice(0, 200).join("\n");
      return new Text(`${head}\n${shown}`, 0, 0);
    },
  });

  // ── ssh-write ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ssh-write",
    label: "ssh-write",
    description:
      "Write a file on a remote host via SSH. Provide 'host' (SSH alias), 'path', and 'content'. For full rewrites or new files. Existing file permissions are preserved.",
    promptSnippet: "Create or overwrite files on a remote SSH host",
    promptGuidelines: [
      "Use ssh-write for new files or full rewrites on a remote host. Provide the host alias.",
      "ssh-write accepts absolute remote paths and preserves the existing file mode (executable stays executable).",
    ],
    parameters: Type.Object({
      host: hostParam,
      path: pathParam,
      content: Type.String({ description: "Full file content" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const host = params.host as string;
      const content = params.content as string;
      const info = await hostInfo(host);
      const absPath = resolveRemotePath(params.path as string, info);

      return withLock(recordKey(host, absPath), async () => {
        const buffer = Buffer.from(content, "utf8");
        const { mode, bytes } = await writeRemoteBytes(host, absPath, buffer, info.posixShell);
        lastSeen.set(recordKey(host, absPath), { digest: digestOf(buffer), size: buffer.length });
        return {
          content: [
            {
              type: "text" as const,
              text: `Wrote ${bytes} bytes to ${absPath} on ${host}${mode ? ` (mode ${mode})` : ""}.`,
            },
          ],
          details: { host, path: absPath, bytes, mode },
        };
      });
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
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Writing…"), 0, 0);
      const details = result.details as { bytes?: number; mode?: string | null } | undefined;
      return new Text(
        theme.fg("success", `wrote ${details?.bytes ?? 0} bytes${details?.mode ? ` · mode ${details.mode}` : ""}`),
        0,
        0,
      );
    },
  });

  // ── ssh-edit ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "ssh-edit",
    label: "ssh-edit",
    description:
      "Edit a file on a remote host via SSH using exact-text replacement. Provide 'host' (SSH alias), 'path', and 'edits' (array of {oldText, newText}). Absolute paths are allowed. Fails loudly if the file changed since your last ssh-read.",
    promptSnippet: "Make precise file edits on a remote SSH host",
    promptGuidelines: [
      "Use ssh-edit for precise remote changes. Provide the SSH host alias.",
      "Each edits[].oldText must match exactly in the remote file; read the file with ssh-read first so drifted files are detected.",
      "If ssh-edit reports the file changed on disk, ssh-read it again and re-apply your edit — do not fall back to shell heredocs.",
    ],
    parameters: Type.Object({
      host: hostParam,
      path: pathParam,
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace" }),
          newText: Type.String({ description: "Replacement text" }),
          replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence (default: require a unique match)" })),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const host = params.host as string;
      const edits = (params.edits as EditSpec[]) ?? [];
      if (edits.length === 0) throw new Error("edits must contain at least one {oldText, newText} entry");

      const info = await hostInfo(host);
      const absPath = resolveRemotePath(params.path as string, info);
      const key = recordKey(host, absPath);

      return withLock(key, async () => {
        requireFile(await remoteFileInfo(host, absPath, info.posixShell), host, absPath);
        const buffer = await readRemoteBytes(host, absPath);
        const currentDigest = digestOf(buffer);
        const seen = lastSeen.get(key);
        if (seen && seen.digest !== currentDigest) {
          throw new Error(
            `${absPath} on ${host} changed on disk since your last read (was ${seen.size} bytes/${seen.digest}, now ${buffer.length} bytes/${currentDigest}). Re-read it with ssh-read, then re-apply the edit.`,
          );
        }

        const current = buffer.toString("utf8");
        const { next, summary } = applyEdits(current, edits, `${absPath}: `);
        const nextBuffer = Buffer.from(next, "utf8");
        const { mode } = await writeRemoteBytes(host, absPath, nextBuffer, info.posixShell);
        lastSeen.set(key, { digest: digestOf(nextBuffer), size: nextBuffer.length });

        const text = [
          `Applied ${summary.length} edit${summary.length === 1 ? "" : "s"} to ${absPath} on ${host} (${buffer.length} → ${nextBuffer.length} bytes${mode ? `, mode ${mode}` : ""}).`,
          ...summary.map((line) => `  ${line}`),
          "",
          diffPreview(edits),
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: { host, path: absPath, applied: summary.length, bytesBefore: buffer.length, bytesAfter: nextBuffer.length, mode },
        };
      });
    },
    renderCall(args, theme) {
      const path = typeof args?.path === "string" ? args.path : "???";
      const host = typeof args?.host === "string" ? args.host : "???";
      const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ssh-edit"))} ${theme.fg("accent", path)} ${theme.fg("muted", `@${host} · ${edits} edit${edits === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Editing…"), 0, 0);
      const details = result.details as { applied?: number; bytesBefore?: number; bytesAfter?: number } | undefined;
      const content = result.content?.[0];
      const body = content && content.type === "text" ? content.text : "";
      return new Text(
        `${theme.fg("success", `${details?.applied ?? 0} edit(s) · ${details?.bytesBefore ?? 0} → ${details?.bytesAfter ?? 0} bytes`)}\n${body.split("\n").slice(1).join("\n")}`,
        0,
        0,
      );
    },
  });

  // ── ssh-bash ─────────────────────────────────────────────────────────────

  function createRemoteBashOps(host: string, remoteCwd: string, bashAvailable: boolean): BashOperations {
    const interpreter = bashAvailable ? "bash -se" : "sh -se";
    return {
      exec: async (command, cwd, { onData, signal, timeout }) => {
        const script = `cd ${shellQuote(cwd)}\n${command}\n`;
        const { exitCode } = await sshExec(host, `exec ${interpreter}`, {
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

  pi.registerTool({
    name: "ssh-bash",
    label: "ssh-bash",
    description:
      "Execute a shell command on a remote host via SSH. Provide 'host' (SSH alias) and 'command'. Runs in the remote home directory under bash, or POSIX sh on hosts without bash (e.g. OPNsense).",
    promptSnippet: "Execute bash commands on a remote SSH host",
    promptGuidelines: [
      "Use ssh-bash when commands must run on a specific remote host. Provide the host alias.",
      "Prefer ssh-read/ssh-write/ssh-edit for file contents; ssh-bash is for commands.",
    ],
    parameters: Type.Object({
      host: hostParam,
      command: bashBase.parameters.properties.command,
      timeout: bashBase.parameters.properties.timeout,
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const host = params.host as string;
      const info = await hostInfo(host);
      const tool = createBashToolDefinition(info.cwd, {
        operations: createRemoteBashOps(host, info.cwd, info.bashAvailable),
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
