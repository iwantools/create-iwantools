# create-iwantools

iwantools 工作空间一键搭建脚手架（爱玩工具站 · Iwan Admin）。macOS / Windows / Linux 同一套代码路径。

```
  iwantools · 爱玩工具站 · Iwan Admin
  工作空间脚手架 v0.3.2

✔ 工作空间名称 … iwantools
✔ 工作空间目录 … /Users/you/Documents/workspace/iwantools
✔ 环境检查 … git 2.50.1 · node 22.22.2 · gh 2.96.0 (you) · java 21.0.11 · pnpm 10.27.0 · docker 27.0.0
✔ 清单已读取 … 4 个仓库
✔ 安装组织 skills 到全局（~/.agents/skills） … 否 / 是
✔ 额外克隆 github-profile （.github） … 否 / 是
✔ 开发环境准备到 › 仅数据库 + Redis （秒级）
✔ 克隆后运行一致性校验 … 否 / 是

  执行计划
  · /Users/you/Documents/workspace/iwantools
  · 克隆入口仓 › 按清单克隆 3 个仓库 › 一致性校验 › 安装组织 skills › 准备开发环境

✔ 入口仓就绪 … /Users/you/Documents/workspace/iwantools
✔ [1/3] iwan-admin
✔ [2/3] iwantools-site-ops
✔ [2/3] iwantools-site-ops upstream → iwantools/iwan-admin
✔ [3/3] ai-skills
✔ 一致性校验通过
✔ skills 2 个 → ~/.agents/skills
✔ Postgres :25432 / Redis :26379 已启动

✔ 工作空间就绪 34.2s
  · 仓库 3/3 · 校验 通过 · skills 已同步 · 仅数据库 + Redis

  接下来
  $ cd /Users/you/Documents/workspace/iwantools
  # 会话开在此目录，对 AI 说「继续」即可接上现场
```

交互层与 `create-vue` 同栈：`prompts`（答过的题留在屏上、值染青色、方向键选择、`否 / 是` 高亮当前项、不可用选项按环境自动禁用并标注原因）。spinner 是自研的 30 行实现——`ora` 会接管 stdin，与 `prompts` 抢输入实测会卡死在第一个提问，因此不引入。颜色遵守 `NO_COLOR` / `FORCE_COLOR` / TTY 检测，重定向到文件时自动降级为纯文本。

## 使用

```bash
npx github:iwantools/create-iwantools          # 未发布 npm 前的即时形态
npm create iwantools                           # 发布后
```

指定名称 / 目录 / 脚本化：

```bash
npx github:iwantools/create-iwantools my-ws
npx github:iwantools/create-iwantools --yes --level skip --dir /data/iwt
```

`--help` 查看全部参数（`--name` / `--dir` / `--yes` / `--skills` / `--skip-skills` / `--level` / `--no-check` / `--check` / `--dry-run`）。
非 TTY 环境（CI、管道）自动进入 `--yes` 模式：不提问、打印与交互模式完全一致的答案行。

## 环境要求

| 依赖 | 必需 | 缺失后果 |
|---|---|---|
| git | 是 | 中止 |
| Node ≥ 20 | 是 | 中止 |
| gh（+ `gh auth login`） | 否 | 回退 `git clone`，私有仓库依赖本机 git 凭据 |
| Java 21 | 否 | 跳过「后端构建」，`full` 档位自动禁用 |
| pnpm（或 corepack） | 否 | 跳过「前端依赖」，`full` 档位自动禁用 |
| Docker（运行中） | 否 | 跳过数据库 / Redis，`db`/`full` 档位自动禁用 |

**只有缺 git / Node 会中止。** 其余缺失只让对应选项变灰并给出该平台的安装或启动命令（`brew` / `winget` / `apt`），工作区照常克隆出来。脚本区分「未安装」与「装了没启动」——Docker Desktop 没开不会被误报成未安装。

## 设计约束

- **硬前置最小化**：拿到工作区（克隆全部仓库）不依赖 Java / pnpm / Docker。
- **单代码路径**：脚本内不调用 bash 脚本、不用 `sh -c`、不拼 `cd && …`；一致性校验与 skills 同步均为 JS 实现，Windows 无需 WSL / Git Bash。
- **Windows 垫片**：`.cmd` / `.bat`（pnpm、npm、mvnw.cmd）统一经 `cmd.exe /d /s /c` 调用，其余直接 spawn；启动即 `chcp 65001`。
- **CRLF 安全**：`workspace/repos.tsv` / `ai-skills/skills.tsv` 按 `\r?\n` 解析，Windows 检出不会污染字段。
- **单仓失败不中止**：gh 克隆失败回退 git，网络抖动重试一次，失败仓库计入汇总并以退出码 1 结束；重跑同目录会自动跳过已存在的仓库。

## 测试

```bash
npm test        # node --test，锁定 Windows 分支：垫片引号、mvnw 选择、CRLF 解析、javaMajor
```

## 说明

- 本包只是**引导器**：不含任何私有信息与凭证。工作空间的唯一权威清单是入口仓 [`iwantools/iwantools`](https://github.com/iwantools/iwantools) 的 `workspace/repos.tsv`；`required=false` 的仓库逐项询问后才克隆
- 完成后日常入口 = 入口仓根目录；详见 `docs/onboarding.md`
- 已知上游缺口：`iwan-admin/server` 只提供 `mvnw`，没有 `mvnw.cmd`，Windows 上后端构建会退回系统 `mvn`（需在 iwan-admin 补 wrapper）
- 发布：仓库根执行 `npm login && npm publish`
