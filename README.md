# pi-remote-tools

SSH remote file and command tools for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Provides `ssh-read`, `ssh-write`, `ssh-edit`, and `ssh-bash` — each takes a `host` parameter, so no toggle state is needed between local and remote work.

## Installation

```bash
pi install npm:@oresk/pi-remote-tools
```

Or install globally:

```bash
npm install -g @oresk/pi-remote-tools
```

## Tools

### ssh-read

Read a file on a remote host via SSH.

```json
{
  "host": "myserver",
  "path": "/etc/os-release",
  "limit": 10
}
```

### ssh-write

Create or overwrite a file on a remote host. Parent directories are created, and the destination's permissions are preserved (an executable script stays executable); new files are written `644`.

```json
{
  "host": "myserver",
  "path": "/tmp/test.txt",
  "content": "hello world"
}
```

### ssh-edit

Make precise file edits on a remote host using exact-text replacement. Each `oldText` must match exactly once unless the edit sets `replaceAll: true`. If the file changed on disk since your last `ssh-read` of it in this session, the edit is refused instead of clobbering the newer content.

```json
{
  "host": "myserver",
  "path": "/etc/nginx/nginx.conf",
  "edits": [
    {
      "oldText": "worker_processes 1;",
      "newText": "worker_processes auto;"
    }
  ]
}
```

A failed match reports the closest line, whitespace/CRLF differences, the file's line count, and a numbered preview of the current content.

### ssh-bash

Execute a shell command on a remote host in the remote home directory. Runs under `bash`; hosts without bash (OPNsense, minimal FreeBSD) fall back to POSIX `sh`.

```json
{
  "host": "myserver",
  "command": "uptime",
  "timeout": 30
}
```

## Path handling

- **Absolute paths are used as-is** — any path the SSH user can reach (`/etc/pve/lxc/158.conf`, `/root/...`). There is no workspace root.
- **Relative paths** resolve against the remote home directory, not the remote shell's cwd.
- **`~`** is expanded remotely.

## Behavior notes

- **No local filesystem involvement.** Paths are never resolved or read on the machine running pi, so remote-only paths like `/root` or `/etc/pve` work even when unreadable locally.
- **File content travels as base64 over stdin/stdout**, never inside a shell command, so quotes, backticks, `$`, CRLF, and heredoc markers in content are inert.
- **Writes are atomic** (temp file in the target directory, then rename).
- **Non-POSIX login shells are supported.** Hosts whose login shell is `csh`/`tcsh` (e.g. OPNsense) get a simple-command write path and BSD `stat` fallbacks.

## Requirements

- SSH keys configured and loaded in your SSH agent (run `ssh-add -l` to verify)
- Host aliases defined in `~/.ssh/config`, or use `user@host` format directly

## Development

`package.json` declares `"pi": { "extensions": ["./dist/index.js"] }`, so pi loads the **compiled** bundle. After editing `index.ts`, rebuild:

```bash
bun x tsc -p tsconfig.json   # or: npm run build
```

## License

MIT
