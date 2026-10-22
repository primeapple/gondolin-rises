# Workspace paths

Status: resolved.

Mount host session CWD at same absolute guest path. Prompt keeps Gondolin VM marker and says host CWD is mounted there. Reject host filesystem root as mount path.

Relative and absolute file paths inside workspace map to that guest path. Reject traversal outside workspace; allow names such as `..notes`. Bash working directory follows same rule. Shell commands remain unrestricted within guest VM.

Verification: `node:test` covers relative and absolute paths through extension tools, `..notes`, traversal rejection, bash CWD, mount path, and VM prompt.
