# MarkPilot for DSH 1.4.0

The plugin is now published as **`dsh-markdown-editor-typora`**. The old `dsh-markdown-typora` package stays at 1.3.x and receives no further updates.

- **Rename:** package name, bundle id, host route prefix, sidebar tab type and recovery-slot prefix move to `dsh-markdown-editor-typora`. Settings and recent-document storage (`dsh.markpilot.*`) keep their keys, so your preferences survive the upgrade.
- **External edits reach the editor:** a clean document adopts the new disk text within 1–2 s; an unsaved draft shows an actionable banner instead of staying stale.
- **Theme sticks:** the editor theme chosen in the toolbar survives host light/dark switches and conversation switches.
- **Sidebar handles stick:** dragged left/right sidebar widths are restored after switching conversations.
- **Transparency can be re-applied:** with transparency on, switching themes no longer leaves an opaque surface; re-applying the setting restores it.
- **Hardening from independent adversarial review:** live refresh refuses to auto-adopt while you are editing, surfaces read failures instead of failing silently, and retries transient store conflicts.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-editor-typora@1.4.0
```

Upgrading from `dsh-markdown-typora`: add the new package, then remove the old one (`dsh plugin --profile desktop remove dsh-markdown-typora`). Do not keep both enabled — they register the same sidebar tab kind and the same Markdown tool.

You can also install the attached `dsh-markdown-editor-typora-1.4.0.tgz` through DSH plugin management, then restart DSH.
