# 这些探针需要开发期的夹具

它们**不是**开箱即用的：需要开发工作区里的夹具/输入文件（内部目录 `.mp-verify/`，未随源码公开）。
放在这里是因为它们示范了"这类判据该怎么写"：照抄思路没问题，直接跑会缺文件。

| 文件 | 分类 | 缺什么 |
|---|---|---|
| `probe-310.cjs` | 缺依赖 | ./accept/v310-specs.cjs |
| `startup-and-menus-patch1c.cjs` | 需开发环境 | tools/probes/startup-and-menus-probe-1.cjs |
| `table-daily-judgement-selftest.cjs` | 需开发环境 | tools/probes/_table-daily-paste.log |
| `corrupt-config-digest.cjs` | 需开发环境 | probes/corrupt-config-out/corrupt-config-1-result.json |
| `diag-render.cjs` | 需开发环境 | tools/probes/items.json |
| `startup-and-menus-patch1e.cjs` | 需开发环境 | tools/probes/startup-and-menus-probe-1.cjs |
| `startup-and-menus-reorder1.cjs` | 需开发环境 | tools/probes/startup-and-menus-probe-1.cjs |
| `startup-and-menus-patch1d.cjs` | 需开发环境 | tools/probes/startup-and-menus-probe-1.cjs |
| `fix-checklist-7.1.cjs` | 需开发环境 | tools/demo/验收清单.md |
| `diag-checklist-blocks.cjs` | 需开发环境 | accept/out/验收清单-重生成.md |
| `diag-checklist-regen-diff.cjs` | 需开发环境 | tools/probes/gen-checklist.cjs |
| `corrupt-config-tally.cjs` | 需开发环境 | probes/corrupt-config-out/corrupt-config-1-result-run2-full10arms.json |
| `settings-truth-dump-cases.cjs` | 需开发环境 | probes/settings-truth-out/probe-1-result.json |
| `check-structure.cjs` | 需开发环境 | tools/demo/验收清单.md |
| `startup-and-menus-patch1b.cjs` | 需开发环境 | tools/probes/startup-and-menus-probe-1.cjs |
