# MarkPilot for DSH 1.3.1

Document links in a conversation now always open in the MarkPilot workspace. The `file://` links that used to do nothing respond, and a plain path chip no longer drags the sidebar change preview along with it.

- **`file://` links respond:** a Markdown document link such as `file:///C:/Users/you/.dsh/AGENTS.md` opens the note in the workspace instead of being ignored.
- **Path chips stay in the workspace:** clicking an absolute `.md` path in a message opens the note in the middle editor and does not open the sidebar preview or its change view.
- **Safe by default:** this build keeps the 1.3.0 fail-closed host authentication fence; a host without `connection.requestRejection` gets `503 host-auth-unavailable` instead of unauthenticated file access.
- **Nothing else changes:** the × memory and the passive-open setting from 1.2.2 are untouched.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.3.1
```

You can also install the attached `dsh-markdown-typora-1.3.1.tgz` through DSH plugin management, then restart DSH.
