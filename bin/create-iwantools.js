#!/usr/bin/env node
/**
 * create-iwantools — iwantools 工作空间一键搭建脚手架
 *
 * 交互式：npx github:iwantools/create-iwantools（或发布后 npx create-iwantools）
 * 非交互：npx github:iwantools/create-iwantools --yes（全部默认值，适合脚本/CI）
 *
 * 引擎复用入口仓（iwantools/iwantools）内的清单与脚本：
 * repos.tsv 驱动克隆；skills 用 ai-skills/scripts/sync.sh；完成后的日常入口见 docs/onboarding.md
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import * as p from '@clack/prompts'

const ENTRY_REPO = 'iwantools/iwantools'
const DEFAULT_DIR = path.join(homedir(), 'Documents', 'workspace', 'iwantools')
const args = process.argv.slice(2)
const yes = args.includes('--yes') || args.includes('-y')

const sh = (cmd, cmdArgs, opts = {}) =>
  spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', ...opts })

function run(cmd, cmdArgs, opts = {}) {
  const r = sh(cmd, cmdArgs, opts)
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') }
}

const REQS = [
  { bin: 'git', args: ['--version'], label: 'git' },
  { bin: 'gh', args: ['--version'], label: 'gh' },
  { bin: 'java', args: ['-version'], label: 'Java 21', verify: (o) => o.includes('"21.') },
  { bin: 'node', args: ['-v'], label: 'Node 22' },
  { bin: 'pnpm', args: ['-v'], label: 'pnpm' },
  { bin: 'docker', args: ['ps'], label: 'Docker（运行中）' },
]

function checkEnv() {
  const missing = []
  for (const req of REQS) {
    const r = run(req.bin, req.args)
    if (!r.ok) { missing.push(req.label); p.log.error(`${req.label} 未安装或不可用`) }
    else if (req.verify && !req.verify(r.output)) { p.log.warn(`${req.label} 版本不符：${r.output.split('\n')[0]}`) }
    else p.log.success(`${req.label} 就绪`)
  }
  return missing
}

function parseReposTsv(tsvPath) {
  const lines = readFileSync(tsvPath, 'utf8').split('\n').filter(Boolean).slice(1)
  return lines.map((line) => {
    const [name, repo, relPath, upstream] = line.split('\t')
    return { name, repo, relPath, upstream: upstream && upstream.trim() ? upstream.trim() : '' }
  })
}

async function main() {
  p.intro(' iwantools workspace · 爱玩工具站 · Iwan Admin ')

  // 1) 环境检查
  let missing
  do {
    missing = checkEnv()
    if (missing.length > 0) {
      p.log.info('macOS 安装：brew install gh && brew install --cask temurin@21 && brew install node@22 && npm i -g pnpm && brew install --cask docker')
      if (yes) { p.cancel('缺少依赖，先补齐后重试'); process.exit(1) }
      const retry = await p.confirm({ message: '已安装/启动后重新检查？', initialValue: true })
      if (!retry) { p.cancel('请先补齐环境'); process.exit(1) }
    }
  } while (missing.length > 0)

  // 2) GitHub 登录
  let login = ''
  const who = run('gh', ['api', 'user', '--jq', '.login'])
  if (who.ok) login = who.output.trim()
  if (!login) {
    if (yes) { p.cancel('gh 未登录，先执行 gh auth login'); process.exit(1) }
    const doLogin = await p.confirm({ message: '未检测到 gh 登录，现在执行 gh auth login？', initialValue: true })
    if (!doLogin) { p.cancel('私有仓库需要 gh 登录'); process.exit(1) }
    sh('gh', ['auth', 'login'], { inherit: true })
    login = run('gh', ['api', 'user', '--jq', '.login']).output.trim()
  }
  p.log.success(`GitHub 已登录：${login || '（身份未读取到，继续）'}`)

  // 3) 目标目录
  let dir = DEFAULT_DIR
  if (!yes) {
    const answer = await p.text({ message: '工作空间目录', placeholder: DEFAULT_DIR, defaultValue: DEFAULT_DIR })
    if (p.isCancel(answer)) { p.cancel('已取消'); process.exit(0) }
    dir = answer.startsWith('~') ? path.join(homedir(), answer.slice(1)) : answer
  }

  // 4) 克隆入口仓
  if (existsSync(path.join(dir, '.git'))) {
    p.log.success(`入口仓已存在：${dir}`)
  } else {
    const s = p.spinner()
    s.start(`克隆入口仓 ${ENTRY_REPO} -> ${dir}`)
    const r = run('gh', ['repo', 'clone', ENTRY_REPO, dir])
    if (!r.ok) { s.stop('克隆失败', 1); p.log.error(r.output); process.exit(1) }
    s.stop(`入口仓就绪：${dir}`)
  }

  // 5) 按清单恢复全部仓库
  const tsv = path.join(dir, 'workspace', 'repos.tsv')
  const repos = parseReposTsv(tsv)
  for (const repo of repos) {
    const target = path.join(dir, repo.relPath)
    if (existsSync(path.join(target, '.git'))) {
      p.log.success(`${repo.name} 已存在（跳过）`)
    } else {
      const s = p.spinner()
      s.start(`克隆 ${repo.name} -> ${repo.relPath}`)
      const r = run('gh', ['repo', 'clone', repo.repo, target])
      if (!r.ok) { s.stop(`${repo.name} 克隆失败`, 1); p.log.error(r.output); process.exit(1) }
      s.stop(`${repo.name} 完成`)
    }
    if (repo.upstream) {
      const has = run('git', ['-C', target, 'remote', 'get-url', 'upstream'])
      if (!has.ok) {
        run('git', ['-C', target, 'remote', 'add', 'upstream', `https://github.com/${repo.upstream}.git`])
        p.log.success(`${repo.name} upstream -> ${repo.upstream}`)
      }
    }
  }

  // 6) 一致性校验
  const s = p.spinner()
  s.start('工作区一致性校验')
  const chk = sh('bash', [path.join(dir, 'scripts', 'check-workspace.sh')])
  const chkOk = chk.status === 0
  s.stop(chkOk ? '校验通过（四仓 ok）' : '校验存在异常', chkOk ? undefined : 1)
  process.stdout.write(`${chk.stdout || ''}${chk.stderr || ''}`)

  // 7) 安装组织 skills（全局）
  let doSkills = true
  if (!yes) {
    doSkills = await p.confirm({ message: '安装组织 skills 到全局（~/.agents/skills）？', initialValue: true })
  }
  if (doSkills) {
    const r = sh('bash', [path.join(dir, 'ai-skills', 'scripts', 'sync.sh'), 'sync'])
    if (r.status === 0) p.log.success('skills 安装完成（iwan-git-workflow、iwan-task-packages）')
    else p.log.warn('skills 安装失败，可稍后执行 ai-skills/scripts/sync.sh sync')
  }

  // 8) 开发环境
  const compose = path.join(dir, 'projects', 'iwan-admin', 'deploy', 'dev', 'docker-compose.yml')
  let level = 'db'
  if (!yes) {
    level = await p.select({
      message: '开发环境准备到什么程度？',
      options: [
        { value: 'db', label: '仅启动数据库 + Redis（最快，秒级）' },
        { value: 'full', label: '数据库 + 前后端依赖与构建（推荐，首次约几分钟）', hint: 'mvn install + pnpm install' },
        { value: 'skip', label: '跳过', hint: '稍后按 docs/onboarding.md 第 5 节手动' },
      ],
    })
    if (p.isCancel(level)) { p.cancel('已取消'); process.exit(0) }
  }
  if (level !== 'skip' && existsSync(compose)) {
    const up = sh('docker', ['compose', '-f', compose, 'up', '-d'])
    if (up.status === 0) p.log.success('数据库 :25432 / Redis :26379 已启动')
    else p.log.error('compose 启动失败（Docker 未运行？）')
    if (level === 'full') {
      const sb = p.spinner(); sb.start('后端构建（首次下载依赖较久）')
      const mvn = sh('sh', ['-c', `cd "${path.join(dir, 'projects', 'iwan-admin', 'server')}" && ./mvnw -q -DskipTests install`])
      sb.stop(mvn.status === 0 ? '后端构建通过' : '后端构建失败', mvn.status === 0 ? undefined : 1)
      if (mvn.status !== 0) process.stdout.write(mvn.output)
      const sw = p.spinner(); sw.start('前端依赖安装')
      const pnpm = sh('sh', ['-c', `cd "${path.join(dir, 'projects', 'iwan-admin', 'web')}" && pnpm install --silent`])
      sw.stop(pnpm.status === 0 ? '前端依赖就绪' : '前端依赖安装失败', pnpm.status === 0 ? undefined : 1)
    }
  }

  p.outro(`工作空间就绪：${dir}
下一步：
  1) 会话开在 ${dir}，对 AI 说「继续」即可接上现场
  2) 起后端（两个 dev secret 见 docs/onboarding.md 第 5 节）
  3) 起前端：VITE_API_PROXY_TARGET=http://localhost:8090 pnpm dev
  4) 首次访问 http://127.0.0.1:5173 → 「初始化入口」创建超级管理员`)
}

main().catch((error) => {
  p.log.error(String(error))
  process.exit(1)
})
