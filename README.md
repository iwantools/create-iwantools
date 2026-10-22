# create-iwantools

iwantools 工作空间一键搭建脚手架（爱玩工具站 · Iwan Admin）。交互式引导：环境检查 → GitHub 登录 → 按清单克隆全部仓库 → 安装组织 skills → 开发环境三档选择 → 完成指引。

## 使用（四种标准入口，任选其一）

```bash
npm create iwantools
pnpm create iwantools
yarn create iwantools
bunx create-iwantools
```

非交互（脚本/CI，全部默认值）：`npm create iwantools -- --yes`

**未发布 npm 前的即时可用形态**（效果完全相同）：

```bash
npx github:iwantools/create-iwantools
```

前置：`git` / `gh` / Java 21 / Node ≥18 / `pnpm` / Docker（缺失时脚手架会给出安装命令并可重检）。克隆私有仓库依赖本机 `gh auth login`。

## 说明

- 本包只是**引导器**：不含任何私有信息与凭证；工作空间的唯一权威清单是入口仓 [`iwantools/iwantools`](https://github.com/iwantools/iwantools) 的 `workspace/repos.tsv`，本工具按清单驱动克隆
- 安装完成后，日常入口 = 入口仓根目录（会话、文档、任务包）；详见入口仓 `docs/onboarding.md`
- 发布：仓库根执行 `npm login && npm publish`
