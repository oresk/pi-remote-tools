# pi-remote-tools

SSH remote file and command tools for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Provides `ssh-read`, `ssh-write`, `ssh-edit`, and `ssh-bash` — each takes a `host` parameter, so no toggle state is needed between local and remote work.

## Installation

```bash
pi extension add @oresk/pi-remote-tools
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

Create or overwrite a file on a remote host.

```json
{
  "host": "myserver",
  "path": "/tmp/test.txt",
  "content": "hello world"
}
```

### ssh-edit

Make precise file edits on a remote host using exact-text replacement.

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

### ssh-bash

Execute a bash command on a remote host.

```json
{
  "host": "myserver",
  "command": "uptime",
  "timeout": 30
}
```

## Requirements

- SSH keys configured and loaded in your SSH agent (run `ssh-add -l` to verify)
- Host aliases defined in `~/.ssh/config`, or use `user@host` format directly

## License

MIT
