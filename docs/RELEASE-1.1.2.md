# MarkPilot for DSH 1.1.2

Closing the editor with × now remembers the working directory of the document you actually closed, so the project you finished with stays quiet while the others keep their behaviour. The choice only takes effect once the editor has really closed, and opening a document from that directory again restores automatic opening.

- **The right directory is remembered:** close a note that belongs to another project while a different conversation is in front, and that note’s own working directory is the one that stays closed.
- **Only a real close counts:** if the editor cannot close yet because a change is still being kept safe, nothing is remembered and the document stays open with a notice.
- **Getting back to automatic is easy:** open Markdown, pick a note from the recent list, or open a Markdown file from the file tree — automatic opening resumes for that directory.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.1.2
```

You can also install the attached `dsh-markdown-typora-1.1.2.tgz` through DSH plugin management, then restart DSH.
