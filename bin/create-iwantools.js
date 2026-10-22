#!/usr/bin/env node
/**
 * create-iwantools — iwantools 工作空间一键搭建脚手架
 *
 * 交互式：npx github:iwantools/create-iwantools
 * 非交互：npx github:iwantools/create-iwantools --yes [--dir <路径>]
 *
 * 两条不可退让的线：
 *  1. 硬前置只有 git + node(>=20)。gh / Java / pnpm / Docker 缺失只降级，不阻断。
 *  2. 全平台单代码路径：不调用 shell 脚本、不用 `sh -c`、不拼 `cd &&`。
 *     Windows 的 .cmd 垫片统一经 cmd.exe /c；路径一律走 spawn 的 cwd。
 *
 * UI 层用 prompts（与 create-vue 同栈）：答过的题留在屏上、值染青色、方向键选择。
 * spinner 与颜色自己实现，只认 NO_COLOR / FORCE_COLOR / isTTY，避免再引一层依赖。
 * 不用 ora：它的 stdin-discarder 会接管 stdin，与 prompts 抢输入，实测卡死在首个提问。
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  cpSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import prompts from 'prompts'

const VERSION = '0.3.1'
const ENTRY_REPO = 'iwantools/iwantools'
const IS_WIN = process.platform === 'win32'
// 仅用于挑选「安装命令文本」。IWANTOOLS_HINT_OS=win32 可在非 Windows 上校验文案。
const HINT_OS = process.env.IWANTOOLS_HINT_OS || process.platform
const DEFAULT_NAME = 'iwantools'
const DEFAULT_DIR = path.join(homedir(), 'Documents', 'workspace', DEFAULT_NAME)

/* ------------------------------------------------------------------- 颜色 */

const COLOR =
  !process.env.NO_COLOR &&
  (Boolean(process.env.FORCE_COLOR) || process.stdout.isTTY === true) &&
  process.env.TERM !== 'dumb'

const sgr = (open, close = '39') => (s) => (COLOR ? `\u001b[${open}m${s}\u001b[${close}m` : String(s))
const c = {
  bold: sgr('1', '22'),
  dim: sgr('2', '22'),
  red: sgr('31'),
  green: sgr('32'),
  yellow: sgr('33'),
  blue: sgr('34'),
  magenta: sgr('35'),
  cyan: sgr('36'),
  gray: sgr('90'),
}

const sym = { ok: '✔', fail: '✖', warn: '!', arrow: '›', dot: '·', field: '…' }

const out = (s = '') => process.stdout.write(`${s}\n`)
const ok = (msg) => out(`${c.green(sym.ok)} ${msg}`)
const fail = (msg) => out(`${c.red(sym.fail)} ${msg}`)
const warn = (msg) => out(`${c.yellow(sym.warn)} ${msg}`)
const note = (msg) => out(`${c.dim(msg)}`)

/* --------------------------------------------------------------- 基础工具 */

const dw = (s) =>
  [...String(s ?? '')].reduce(
    (n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1),
    0,
  )
// 表格宽度按「可见字符」算，需先剥 ANSI
const stripAnsi = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '')
const pad = (s, w) => String(s ?? '') + ' '.repeat(Math.max(0, w - dw(stripAnsi(s))))

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(dw(stripAnsi(h)), ...rows.map((r) => dw(stripAnsi(r[i])))))
  const line = (cells) => cells.map((cell, i) => (i === cells.length - 1 ? String(cell ?? '') : pad(cell, widths[i]))).join('  ')
  const head = line(headers.map((h) => c.dim(h)))
  const rule = widths.map((w) => c.dim('─'.repeat(w))).join('  ')
  return [head, rule, ...rows.map(line)].join('\n')
}

function which(bin) {
  const exts =
    IS_WIN || HINT_OS === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : ['']
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, bin + ext)
      try {
        if (existsSync(file) && statSync(file).isFile()) return file
      } catch {}
    }
  }
  return null
}

const quoteWin = (s) => (/[\s"&|<>^]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s))

/**
 * 纯函数：把 (cmd, args) 解析为真正要 spawn 的 (file, argv)。
 * isWin 可注入 → 非 Windows 环境也能验证垫片引号逻辑（见 tests/）。
 */
export function invocationOf(cmd, args, { isWin, resolved } = {}) {
  const file = resolved || cmd
  if (isWin && /\.(cmd|bat)$/i.test(file)) {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      argv: ['/d', '/s', '/c', `"${[file, ...args].map(quoteWin).join(' ')}"`],
    }
  }
  return { file, argv: args }
}

/** 统一执行入口：Windows 的 .cmd/.bat 垫片经 cmd.exe 调；其余直接 spawn。永不使用 shell:true。 */
function run(cmd, args = [], opts = {}) {
  const { cwd, inherit = false, timeout = 0, env } = opts
  const { file, argv } = invocationOf(cmd, args, { isWin: IS_WIN, resolved: which(cmd) })
  const r = spawnSync(file, argv, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    timeout: timeout || undefined,
    windowsHide: true,
  })
  const stdout = r.stdout || ''
  const stderr = r.stderr || ''
  return { ok: r.status === 0, code: r.status, out: stdout + stderr, stdout, stderr, err: r.error }
}

const sleep = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {}
}

/**
 * 极简 spinner。自己实现而不用 ora，原因有二：
 *  1. ora 会接管 stdin（stdin-discarder），与 prompts 抢输入，实测会卡死在第一个提问；
 *  2. 少一个依赖，且颜色/符号与其它输出完全一致。
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
function spinner(text) {
  let i = 0
  let timer = null
  let live = false
  const draw = () => process.stdout.write(`\r\u001b[2K  ${c.cyan(FRAMES[i])} ${text}`)
  const finish = (mark, color, msg) => {
    if (timer) clearInterval(timer)
    timer = null
    const body = msg ?? text
    if (live) {
      process.stdout.write(`\r\u001b[2K${color(mark)} ${body}\n`)
      live = false
    } else out(`${color(mark)} ${body}`)
  }
  return {
    start() {
      if (!process.stdout.isTTY) {
        out(`${c.dim('·')} ${text}`)
        return this
      }
      live = true
      draw()
      timer = setInterval(() => {
        i = (i + 1) % FRAMES.length
        draw()
      }, 90)
      timer.unref?.()
      return this
    },
    succeed(msg) {
      finish(sym.ok, c.green, msg)
    },
    fail(msg) {
      finish(sym.fail, c.red, msg)
    },
    warn(msg) {
      finish(sym.warn, c.yellow, msg)
    },
  }
}

/** 读 TSV：跳过空行与 # 注释，按首行表头映射字段，CRLF 安全。 */
export function readTsv(file) {
  return parseTsvText(readFileSync(file, 'utf8'))
}

export function parseTsvText(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (lines.length < 1) return []
  const head = lines[0].split('\t').map((s) => s.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split('\t')
    const row = {}
    head.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()))
    return row
  })
}

/**
 * 不克隆也先拿到清单（gh 一次 API 调用），这样所有问题能在「干活之前」一次性问完，
 * 计划里的仓库数量也是准的。拿不到就返回 null，退回「克隆后再问」。
 */
export function fetchManifest(entryRepo, { timeout = 20000 } = {}) {
  if (!which('gh')) return null
  const r = run('gh', ['api', `repos/${entryRepo}/contents/workspace/repos.tsv`, '-H', 'Accept: application/vnd.github.raw'], { timeout })
  if (!r.ok) return null
  const text = r.stdout
  if (!text.includes('repository') || !text.includes('\t')) return null
  const rows = parseTsvText(text)
  return rows.length ? rows : null
}

function parseArgs(argv) {
  const o = {
    yes: false,
    dir: '',
    name: '',
    help: false,
    version: false,
    skills: undefined,
    level: '',
    deep: false,
    check: true,
    dry: false,
  }
  const unknown = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') o.help = true
    else if (a === '-v' || a === '--version') o.version = true
    else if (a === '-y' || a === '--yes') o.yes = true
    else if (a === '--dir') o.dir = argv[++i] || ''
    else if (a.startsWith('--dir=')) o.dir = a.slice(6)
    else if (a === '--name') o.name = argv[++i] || ''
    else if (a.startsWith('--name=')) o.name = a.slice(7)
    else if (a === '--skills') o.skills = true
    else if (a === '--skip-skills' || a === '--no-skills') o.skills = false
    else if (a === '--level' || a === '--db') o.level = (argv[++i] || '').toLowerCase()
    else if (a.startsWith('--level=') || a.startsWith('--db=')) o.level = a.split('=')[1].toLowerCase()
    else if (a === '--no-check') o.check = false
    else if (a === '--check') o.deep = true
    else if (a === '--deep') o.deep = true
    else if (a === '--dry-run') o.dry = true
    else if (!a.startsWith('-')) o.name = o.name || a
    else unknown.push(a)
  }
  return { o, unknown }
}

function usage() {
  return `${c.bold('create-iwantools')} ${c.dim(VERSION)} — iwantools 工作空间搭建

${c.bold('用法')}
  npx github:iwantools/create-iwantools [名称] [选项]
  npm create iwantools -- [选项]

${c.bold('选项')}
  --dir <路径>         工作空间目录（默认 ${DEFAULT_DIR}）
  --name <名称>        工作空间名称（默认 ${DEFAULT_NAME}）
  -y, --yes            全默认、不提问（CI 用；非 TTY 时自动启用）
  --skills             安装组织 skills（默认询问）
  --skip-skills        不安装组织 skills
  --level <档位>       开发环境：db | full | skip（默认询问）
  --no-check           跳过克隆后的一致性校验
  --check, --deep      一致性校验时额外查询 GitHub 远程仓库是否存在
  --dry-run            完成提问与环境检查后打印计划，不做任何写入
  -h, --help           显示本帮助
  -v, --version        显示版本

${c.bold('环境要求')}
  必需：git、Node >= 20
  可选：gh（私有仓库克隆）、Java 21、pnpm、Docker —— 缺失只跳过对应步骤

${c.bold('退出码')}
  0 成功或用户取消   1 必需依赖缺失 / 必需仓库克隆失败`
}

/* ------------------------------------------------------------ 依赖探测与建议 */

const FIX = {
  git: { darwin: 'brew install git', win32: 'winget install --id Git.Git -e', linux: 'sudo apt install -y git' },
  gh: { darwin: 'brew install gh', win32: 'winget install --id GitHub.cli -e', linux: 'sudo apt install -y gh' },
  node: {
    darwin: 'brew install node@22',
    win32: 'winget install --id OpenJS.NodeJS.LTS -e',
    linux: 'nvm install 22 && nvm use 22',
  },
  java: {
    darwin: 'brew install --cask temurin@21',
    win32: 'winget install --id EclipseAdoptium.Temurin.21.JDK -e',
    linux: 'sudo apt install -y openjdk-21-jdk',
  },
  pnpm: { darwin: 'corepack enable pnpm', win32: 'corepack enable pnpm', linux: 'corepack enable pnpm' },
  docker: {
    darwin: 'brew install --cask docker  # 装完启动 Docker Desktop',
    win32: 'winget install --id Docker.DockerDesktop -e  # 装完启动 Docker Desktop',
    linux: 'curl -fsSL https://get.docker.com | sh',
  },
}

const FIX_START = {
  darwin: 'open -a Docker',
  win32: '启动 Docker Desktop，等托盘图标变绿',
  linux: 'sudo systemctl start docker',
}

const fixOf = (key) => FIX[key][HINT_OS] || FIX[key].linux

export const major = (v) => {
  const m = String(v).match(/\d+/)
  return m ? Number(m[0]) : 0
}

export function javaMajor(out) {
  const m = out.match(/version\s+"?(\d+)(?:\.(\d+))?/i) || out.match(/\b(\d+)\.(\d+)/)
  if (!m) return 0
  const first = Number(m[1])
  return first === 1 ? Number(m[2] || 0) : first
}

/**
 * 探测所有依赖。每项 { key, label, status, detail, required }
 *   ok | old（装了但版本/登录不符） | miss（未安装） | stopped（装了没启动）
 */
export function probeEnv() {
  const items = []
  const push = (key, label, required, fn) => items.push({ key, label, required, ...fn() })

  push('git', 'git', true, () => {
    const r = run('git', ['--version'])
    const v = (r.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || ''
    return r.ok ? { status: 'ok', detail: v } : { status: 'miss', detail: '' }
  })

  push('node', 'node', true, () => {
    const r = run('node', ['-v'])
    if (!r.ok) return { status: 'miss', detail: '' }
    const v = r.out.trim().replace(/^v/, '')
    return major(v) >= 20 ? { status: 'ok', detail: v } : { status: 'old', detail: `${v}（需 ≥20）` }
  })

  push('gh', 'gh', false, () => {
    const r = run('gh', ['--version'])
    if (!r.ok) return { status: 'miss', detail: '' }
    const v = (r.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || ''
    const me = run('gh', ['api', 'user', '--jq', '.login'])
    const login = me.ok ? me.out.trim() : ''
    return login ? { status: 'ok', detail: `${v} (${login})` } : { status: 'old', detail: v }
  })

  push('java', 'java', false, () => {
    const r = run('java', ['-version'])
    if (!r.ok) return { status: 'miss', detail: '' }
    const ver = (r.out.match(/version\s+"?([\d._]+)/i) || [])[1] || ''
    const mj = javaMajor(r.out)
    return mj === 21 ? { status: 'ok', detail: ver } : { status: 'old', detail: `${ver || '?'}（需 21）` }
  })

  push('pnpm', 'pnpm', false, () => {
    const r = run('pnpm', ['-v'])
    if (r.ok) return { status: 'ok', detail: r.out.trim().split(/\r?\n/)[0] }
    return which('corepack') ? { status: 'miss', detail: 'corepack 可代跑' } : { status: 'miss', detail: '' }
  })

  push('docker', 'docker', false, () => {
    const v = run('docker', ['--version'])
    if (!v.ok) return { status: 'miss', detail: '' }
    const ver = (v.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || ''
    const ps = run('docker', ['ps'], { timeout: 20000 })
    // 已安装但守护进程未起来：Docker Desktop 上极常见，不能等同「未安装」
    return ps.ok ? { status: 'ok', detail: ver } : { status: 'stopped', detail: `${ver}（未启动）` }
  })

  return items
}

/** 一行式环境摘要：ok 的连成一行，有问题的逐条带修复命令。 */
function reportEnv(items) {
  const good = items.filter((i) => i.status === 'ok')
  ok(`${c.bold('环境检查')} ${c.dim(sym.field)} ${good.map((i) => `${c.dim(i.label)} ${i.detail}`).join(c.dim(` ${sym.dot} `))}`)
  for (const it of items.filter((i) => i.status !== 'ok')) {
    const why = it.status === 'miss' ? '未安装' : it.status === 'stopped' ? it.detail : it.detail
    const advice = it.status === 'stopped' ? FIX_START[HINT_OS] || FIX_START.linux : fixOf(it.key)
    const line = `${it.label} ${why}  ${c.dim(sym.arrow)} ${c.cyan(advice)}`
    if (it.required) fail(line)
    else warn(`${line}  ${c.dim('（该步骤将跳过）')}`)
  }
}

/** 当前环境能支撑哪些开发环境档位 */
function levelChoices(env) {
  const st = (k) => env.find((e) => e.key === k).status
  const dockerOk = st('docker') === 'ok'
  const javaOk = st('java') === 'ok'
  const pnpmOk = st('pnpm') === 'ok' || Boolean(which('corepack'))
  const fullMissing = [!dockerOk && 'Docker', !javaOk && 'Java 21', !pnpmOk && 'pnpm'].filter(Boolean)
  return [
    {
      title: dockerOk ? `仅数据库 + Redis  ${c.dim('（秒级）')}` : `仅数据库 + Redis  ${c.dim('（Docker 不可用，已禁用）')}`,
      value: 'db',
      disabled: !dockerOk,
    },
    {
      title: fullMissing.length
        ? `数据库 + 后端构建 + 前端依赖  ${c.dim(`（缺 ${fullMissing.join(' / ')}，已禁用）`)}`
        : `数据库 + 后端构建 + 前端依赖  ${c.dim('（约几分钟）')}`,
      value: 'full',
      disabled: fullMissing.length > 0,
    },
    { title: `跳过  ${c.dim('（稍后手动）')}`, value: 'skip' },
  ]
}

/* ----------------------------------------------------------------- 提问层 */

const fmtVal = (v) => c.cyan(typeof v === 'string' ? v : String(v))
const answered = (message, value) => out(`${c.green(sym.ok)} ${c.bold(message)} ${c.dim(sym.field)} ${fmtVal(value)}`)

const labelOf = (choices, value) => {
  const hit = (choices || []).find((ch) => ch.value === value)
  const t = hit ? hit.title : value
  return stripAnsi(t).replace(/\s*（.*）\s*$/, '').trim()
}

/**
 * 统一提问入口。create-vue 观感的关键：答过的题留在屏上（prompts 默认行为），
 * 值染青；非交互时自己打印同款行，保证输出完全一致。
 * preset 用于命令行已给值的场景（--level / --skills / --dir）。
 */
async function ask(q, ctx, preset) {
  const { type, name, message, choices = [], active = '是', inactive = '否', validate } = q
  const shown = (v) => (type === 'toggle' ? (v ? active : inactive) : type === 'select' ? labelOf(choices, v) : v)
  const fallback = q.def ?? (type === 'toggle' ? Boolean(q.initial) : type === 'select' ? choices.find((ch) => !ch.disabled)?.value : q.initial)

  if (preset !== undefined) {
    answered(message, shown(preset))
    return preset
  }
  if (ctx.auto) {
    answered(message, shown(fallback))
    return fallback
  }

  // prompts 的 select 只认 initial 索引
  const initialIndex = type === 'select' ? Math.max(0, choices.findIndex((ch) => ch.value === fallback && !ch.disabled)) : undefined
  const res = await prompts(
    {
      type,
      name,
      message, // prompts 自己会加粗，别再包一层（会出双 bold）
      initial: type === 'select' ? initialIndex : q.initial,
      choices,
      active,
      inactive,
      validate,
      instructions: false,
      hint: type === 'select' ? c.dim('↑↓ 选择 · Enter 确认') : undefined,
    },
    {
      onCancel: () => {
        ctx.canceled = true
        return false
      },
    },
  )
  if (ctx.canceled) return undefined
  return res[name]
}

/* ----------------------------------------------------------------- 克隆实现 */

/** 失败后清理半成品目录：只删「空目录」或「仅含 .git」。 */
function cleanPartial(dest) {
  try {
    if (!existsSync(dest)) return
    const left = readdirSync(dest)
    if (left.length === 0 || left.every((n) => n === '.git')) rmSync(dest, { recursive: true, force: true })
  } catch {}
}

function cloneRepo(repo, dest, { useGh }) {
  const attempts = []
  if (useGh) attempts.push(['gh', ['repo', 'clone', repo, dest]])
  attempts.push(['git', ['clone', '--quiet', `https://github.com/${repo}.git`, dest]])

  for (let i = 0; i < attempts.length; i++) {
    const [cmd, args] = attempts[i]
    const r = run(cmd, args, { timeout: 600000 })
    if (r.ok) return { ok: true }
    cleanPartial(dest)
    if (cmd === 'gh' && attempts.length > 1) warn(`gh 克隆失败，回退 git clone：${c.dim(repo)}`)
  }
  // 网络抖动再试一次
  const [cmd, args] = attempts[attempts.length - 1]
  const retry = run(cmd, args, { timeout: 600000 })
  if (retry.ok) return { ok: true }
  cleanPartial(dest)
  return { ok: false, out: (retry.out || '').trim() }
}

/* ------------------------------------------------------------ 一致性校验（JS） */

export function checkWorkspace(root, rows, deep) {
  const list = []
  let bad = 0
  for (const row of rows) {
    const dir = path.join(root, row.path)
    const required = (row.required ?? 'true') !== 'false'
    const item = { name: row.name, clone: 'ok', origin: '-', upstream: row.upstream ? '-' : '', state: '' }

    if (!existsSync(path.join(dir, '.git'))) {
      item.clone = 'MISS'
      if (required) bad++
      list.push(item)
      continue
    }
    const origin = run('git', ['-C', dir, 'remote', 'get-url', 'origin']).out
    if (origin.includes(row.repository)) item.origin = 'ok'
    else {
      item.origin = 'DIFF'
      if (required) bad++
    }
    if (row.upstream) {
      const u = run('git', ['-C', dir, 'remote', 'get-url', 'upstream']).out
      if (u.includes(row.upstream)) item.upstream = 'ok'
      else {
        item.upstream = 'MISS'
        if (required) bad++
      }
    }
    if (deep) {
      const r = run('gh', ['api', `repos/${row.repository}`, '--jq', '.full_name'], { timeout: 30000 })
      if (!r.ok) {
        item.state = 'remote?'
        if (required) bad++
      }
    }
    const dirty = run('git', ['-C', dir, 'status', '--porcelain']).out.trim()
    if (dirty) item.state = `${item.state} dirty:${dirty.split(/\r?\n/).length}`.trim()
    list.push(item)
  }
  return { list, bad }
}

function paintCell(v) {
  if (v === 'ok') return c.green(v)
  if (v === 'DIFF' || v === 'MISS' || v === 'remote?') return c.red(v)
  if (v === 'clean') return c.dim(v)
  if (v === '' || v === '-') return c.dim(v || '-')
  return c.yellow(v)
}

/* --------------------------------------------------------------- skills 同步 */

export function syncSkills(root) {
  const src = path.join(root, 'ai-skills')
  const states = path.join(src, 'skills.tsv')
  if (!existsSync(states)) return { ok: false, done: [], failed: ['ai-skills/skills.tsv 缺失'] }
  const runtime = process.env.AGENTS_SKILLS_DIR || path.join(homedir(), '.agents', 'skills')
  const names = readTsv(states)
    .filter((r) => ['draft', 'usable', 'trusted'].includes((r.state || '').toLowerCase()))
    .map((r) => r.name)
    .filter(Boolean)
  if (!names.length) return { ok: true, runtime, done: [], failed: [] }

  const done = []
  const failed = []
  mkdirSync(runtime, { recursive: true })
  for (const name of names) {
    const from = path.join(src, 'skills', name)
    const to = path.join(runtime, name)
    if (!existsSync(from)) {
      failed.push(`${name}（源码缺失）`)
      continue
    }
    try {
      rmSync(to, { recursive: true, force: true })
      cpSync(from, to, { recursive: true })
      done.push(name)
    } catch (e) {
      failed.push(`${name}（${e.code || e.message}）`)
    }
  }
  try {
    writeFileSync(path.join(runtime, '.iwantools-owned.json'), `${JSON.stringify({ owned: done }, null, 2)}\n`)
  } catch {}
  return { ok: failed.length === 0, runtime, done, failed }
}

/* ------------------------------------------------------------- 后端命令解析 */

/**
 * 后端构建命令解析（Windows 上 wrapper 缺 mvnw.cmd 是常态）。
 * 顺序：mvnw.cmd → 系统 mvn → bash mvnw（最后手段）。
 */
export function mavenInvocation(serverDir, { isWin, hasBin = () => false } = {}) {
  const args = ['-q', '-DskipTests', 'install']
  const cmdShim = path.join(serverDir, 'mvnw.cmd')
  const shScript = path.join(serverDir, 'mvnw')
  const hasCmd = existsSync(cmdShim)
  const hasSh = existsSync(shScript)
  if (isWin) {
    if (hasCmd) return { cmd: cmdShim, args, note: 'mvnw.cmd' }
    if (hasBin('mvn')) return { cmd: 'mvn', args, note: '系统 mvn（该仓缺 mvnw.cmd）' }
    if (hasSh) return { cmd: 'bash', args: [shScript, ...args], note: 'bash + mvnw（需 Git Bash / WSL）' }
    return null
  }
  if (hasSh) return { cmd: shScript, args, note: 'mvnw' }
  if (hasBin('mvn')) return { cmd: 'mvn', args, note: '系统 mvn' }
  return null
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const { o, unknown } = parseArgs(process.argv.slice(2))

  // Windows 旧控制台默认 GBK，中文/框线/颜色都会乱；切 UTF-8
  if (IS_WIN) run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp', '65001'])

  if (o.help) {
    out(usage())
    out()
    return 0
  }
  if (o.version) {
    out(VERSION)
    return 0
  }

  const started = Date.now()
  const ctx = { auto: o.yes || !(process.stdin.isTTY && process.stdout.isTTY), canceled: false }

  out()
  out(`  ${c.bold(c.cyan('iwantools'))} ${c.dim(sym.dot)} ${c.bold('爱玩工具站')} ${c.dim(sym.dot)} ${c.bold('Iwan Admin')}`)
  out(`  ${c.dim('工作空间脚手架')} ${c.dim(`v${VERSION}`)}`)
  out()
  if (unknown.length) warn(`忽略未知参数：${unknown.join(' ')}  ${c.dim('（--help 查看用法）')}`)
  if (ctx.auto && !o.yes) note(`  非交互终端：自动采用默认值`)

  /* 1) 名称与目录 ------------------------------------------------------- */
  const name =
    (await ask(
      {
        type: 'text',
        name: 'name',
        message: '工作空间名称',
        initial: DEFAULT_NAME,
        validate: (v) => (/^[\w.-]+$/.test(v) ? true : '只允许字母、数字、- . _'),
      },
      ctx,
      o.name || undefined,
    )) ?? ''
  if (ctx.canceled) {
    note('  已取消')
    return 0
  }

  const dirDefault = path.join(homedir(), 'Documents', 'workspace', name || DEFAULT_NAME)
  let dir = o.dir || ''
  if (dir) {
    if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(homedir(), dir.slice(1))
    answered('工作空间目录', path.resolve(dir))
  } else {
    dir = await ask({ type: 'text', name: 'dir', message: '工作空间目录', initial: dirDefault }, ctx)
    if (ctx.canceled) {
      note('  已取消')
      return 0
    }
  }
  dir = path.resolve(String(dir || dirDefault))

  /* 2) 环境检查 --------------------------------------------------------- */
  const env = probeEnv()
  reportEnv(env)
  out()

  const blocking = env.filter((e) => e.required && e.status !== 'ok')
  if (blocking.length) {
    fail(`${c.bold('缺少必需依赖')}：${blocking.map((b) => b.label).join('、')}`)
    note('  补齐后重跑本命令即可')
    return 1
  }

  /* 3) 目录冲突检查 ----------------------------------------------------- */
  const entryExists = existsSync(path.join(dir, '.git'))
  if (!entryExists && existsSync(dir) && readdirSync(dir).length > 0) {
    fail(`目录已存在且不是 git 仓库：${dir}`)
    note('  换一个目录（--dir <路径>），或先清理该目录后重试')
    return 1
  }

  /* 4) 选择项 ----------------------------------------------------------- */
  const gh = env.find((e) => e.key === 'gh')
  const useGh = gh.status === 'ok' || (gh.status === 'old' && which('gh') !== null)

  if (gh.status === 'miss') warn(`未装 gh：私有仓库将用本机 git 凭据克隆`)
  else if (gh.status === 'old' && !ctx.auto) {
    const login = await ask(
      { type: 'toggle', name: 'login', message: 'gh 未登录，现在执行 gh auth login', initial: true, active: '是', inactive: '否' },
      ctx,
    )
    if (ctx.canceled) return 0
    if (login) {
      run('gh', ['auth', 'login'], { inherit: true })
      const me = run('gh', ['api', 'user', '--jq', '.login'])
      if (me.ok && me.out.trim()) ok(`GitHub 已登录  ${c.dim(sym.field)} ${fmtVal(me.out.trim())}`)
      else warn('登录未完成，继续尝试克隆（可能因权限失败）')
    }
  }

  // 清单在入口仓内。已克隆就直接读；未克隆就先用 gh 拉一次，
  // 让「装哪些仓库」这类问题跟其它问题排在一起，而不是干到一半再跳出来问。
  const manifestPath = path.join(dir, 'workspace', 'repos.tsv')
  let known = null
  if (entryExists && existsSync(manifestPath)) known = readTsv(manifestPath)
  else if (which('gh') && !ctx.auto) {
    const sp = spinner('读取入口仓清单')
    sp.start()
    known = fetchManifest(ENTRY_REPO)
    if (known) sp.succeed(`清单已读取 ${c.dim(sym.field)} ${known.length} 个仓库`)
    else sp.warn('清单读取失败，将在克隆后询问')
  }
  const picked = new Set()

  /** 可选仓库（required=false）逐项询问；--yes 时一律不装 */
  const askOptional = async (rows) => {
    for (const row of rows.filter((r) => (r.required ?? 'true') === 'false')) {
      if (ctx.auto) continue
      const want = await ask(
        { type: 'toggle', name: 'extra', message: `额外克隆 ${row.name} ${c.dim(`（${row.path}）`)}`, initial: false },
        ctx,
      )
      if (ctx.canceled) return false
      if (want) picked.add(row.name)
    }
    return true
  }
  let askedOptional = false

  const doSkills = await ask(
    { type: 'toggle', name: 'skills', message: '安装组织 skills 到全局（~/.agents/skills）', initial: true, active: '是', inactive: '否' },
    ctx,
    o.skills,
  )
  if (ctx.canceled) return 0

  if (known && !(await askOptional(known))) return 0
  if (known) askedOptional = true

  const levels = levelChoices(env)
  const preferredLevel = levels.find((ch) => !ch.disabled)?.value || 'skip'
  const level = await ask(
    { type: 'select', name: 'level', message: '开发环境准备到', choices: levels, def: preferredLevel },
    ctx,
    o.level || undefined,
  )
  if (ctx.canceled) return 0

  const doCheck = await ask(
    { type: 'toggle', name: 'check', message: '克隆后运行一致性校验', initial: true, active: '是', inactive: '否' },
    ctx,
    o.check === false ? false : undefined,
  )
  if (ctx.canceled) return 0

  /* 5) 计划确认 --------------------------------------------------------- */
  const levelText = level === 'skip' ? '跳过' : level === 'full' ? '数据库 + 后端构建 + 前端依赖' : '仅数据库 + Redis'
  const plannedCount = known
    ? known.filter((row) => (row.required ?? 'true') !== 'false' || picked.has(row.name)).length
    : null
  const todo = [
    entryExists ? null : '克隆入口仓',
    plannedCount === null ? '按清单克隆全部仓库' : `按清单克隆 ${plannedCount} 个仓库`,
    doCheck ? '一致性校验' : null,
    doSkills ? '安装组织 skills' : null,
    level === 'skip' ? null : '准备开发环境',
  ].filter(Boolean)

  out()
  out(`  ${c.bold('执行计划')}`)
  out(`  ${c.dim(sym.dot)} ${dir}${entryExists ? c.dim('（入口仓已存在，自动跳过克隆）') : ''}`)
  out(`  ${c.dim(sym.dot)} ${todo.join(c.dim(` ${sym.arrow} `))}`)
  out(`  ${c.dim(sym.dot)} 开发环境 ${c.cyan(levelText)}`)

  if (o.dry) {
    out()
    note(`  --dry-run：未做任何写入`)
    return 0
  }

  /* 6) 克隆入口仓 ------------------------------------------------------- */
  out()
  if (entryExists) ok(`入口仓已存在  ${c.dim(sym.field)} ${fmtVal(dir)}`)
  else {
    const sp = spinner(`克隆入口仓 ${canonicalize(ENTRY_REPO)}`)
    sp.start()
    mkdirSync(path.dirname(dir), { recursive: true })
    const r = cloneRepo(ENTRY_REPO, dir, { useGh })
    if (!r.ok) {
      sp.fail(`入口仓克隆失败`)
      if (r.out) out(c.dim(indent(r.out, 4)))
      note(`  排查：确认 gh 已登录（gh auth login）或本机有 GitHub 凭据`)
      note(`  也可手动：git clone https://github.com/${ENTRY_REPO}.git "${dir}"`)
      return 1
    }
    sp.succeed(`入口仓就绪  ${c.dim(sym.field)} ${fmtVal(dir)}`)
  }

  const tsv = path.join(dir, 'workspace', 'repos.tsv')
  if (!existsSync(tsv)) {
    fail('清单缺失：workspace/repos.tsv（入口仓克隆不完整？）')
    return 1
  }
  const manifestAll = readTsv(tsv)

  // 新克隆时清单此刻才可见，可选仓库只能在这时问（唯一诚实的时机）
  if (!askedOptional) {
    if (!(await askOptional(manifestAll))) return 0
    askedOptional = true
  }
  const manifest = manifestAll.filter((row) => (row.required ?? 'true') !== 'false' || picked.has(row.name))

  /* 7) 按清单克隆 ------------------------------------------------------- */
  const cloneFailed = []
  for (let i = 0; i < manifest.length; i++) {
    const row = manifest[i]
    const target = path.join(dir, row.path)
    const counter = c.dim(`[${i + 1}/${manifest.length}]`)
    if (existsSync(path.join(target, '.git'))) {
      ok(`${counter} ${row.name} ${c.dim('已存在，跳过')}`)
    } else {
      const sp = spinner(`${counter} 克隆 ${row.name} ${c.dim(`→ ${row.path}`)}`)
      sp.start()
      const r = cloneRepo(row.repository, target, { useGh })
      if (r.ok) sp.succeed(`${counter} ${row.name}`)
      else {
        sp.fail(`${counter} ${row.name} 失败`)
        if (r.out) out(c.dim(indent(r.out, 4)))
        cloneFailed.push({ name: row.name, repo: row.repository })
      }
    }
    if (row.upstream && existsSync(path.join(target, '.git'))) {
      if (!run('git', ['-C', target, 'remote', 'get-url', 'upstream']).ok) {
        const add = run('git', ['-C', target, 'remote', 'add', 'upstream', `https://github.com/${row.upstream}.git`])
        if (add.ok) ok(`${counter} ${row.name} upstream ${c.dim(sym.arrow)} ${canonicalize(row.upstream)}`)
      }
    }
  }

  /* 8) 一致性校验 ------------------------------------------------------- */
  let bad = 0
  if (doCheck) {
    out()
    const sp = spinner(o.deep ? '一致性校验（含远程查询）' : '一致性校验')
    sp.start()
    const res = checkWorkspace(dir, manifest, o.deep)
    bad = res.bad
    if (bad === 0) sp.succeed('一致性校验通过')
    else sp.fail(`一致性校验发现 ${bad} 处待处理`)
    out()
    out(
      indent(
        table(
          ['仓库', 'CLONE', 'ORIGIN', 'UPSTREAM', 'STATE'],
          res.list.map((r) => [c.bold(r.name), paintCell(r.clone), paintCell(r.origin), paintCell(r.upstream), paintCell(r.state || 'clean')]),
        ),
        2,
      ),
    )
  }

  /* 9) skills ----------------------------------------------------------- */
  out()
  if (doSkills) {
    const sp = spinner('安装组织 skills 到全局')
    sp.start()
    const r = syncSkills(dir)
    if (r.ok) sp.succeed(`skills ${r.done.length} 个 ${c.dim(sym.arrow)} ${c.dim(r.runtime)}`)
    else {
      sp.warn('skills 部分失败')
      for (const f of r.failed) warn(`  ${f}`)
      note(`  可稍后手动：bash ai-skills/scripts/sync.sh sync`)
    }
  }

  /* 10) 开发环境 -------------------------------------------------------- */
  const pending = []
  const dockerOk = env.find((e) => e.key === 'docker').status === 'ok'
  const adminDir = path.join(dir, 'projects', 'iwan-admin')
  const compose = path.join(adminDir, 'deploy', 'dev', 'docker-compose.yml')

  if (level !== 'skip') {
    if (!dockerOk) pending.push('数据库未启动：Docker 不可用')
    else if (!existsSync(compose)) pending.push(`数据库未启动：找不到 ${path.relative(dir, compose)}`)
    else {
      const sp = spinner('启动 Postgres + Redis')
      sp.start()
      const up = run('docker', ['compose', '-f', compose, 'up', '-d'], { timeout: 600000 })
      if (up.ok) sp.succeed(`Postgres ${c.dim(':25432')} / Redis ${c.dim(':26379')} 已启动`)
      else {
        sp.fail('compose 启动失败')
        out(c.dim(indent(up.out.trim().split(/\r?\n/).slice(-5).join('\n'), 4)))
        pending.push(`数据库启动失败：${FIX_START[HINT_OS] || FIX_START.linux}`)
      }
    }
  }

  if (level === 'full') {
    const serverDir = path.join(adminDir, 'server')
    const javaOk = env.find((e) => e.key === 'java').status === 'ok'
    if (!javaOk) pending.push('后端未构建：Java 21 缺失或版本不符')
    else if (!existsSync(serverDir)) pending.push('后端未构建：projects/iwan-admin/server 不存在')
    else {
      const mvn = mavenInvocation(serverDir, { isWin: IS_WIN, hasBin: (b) => which(b) !== null })
      if (!mvn) pending.push('后端未构建：缺 mvnw.cmd 且未找到 mvn（Windows 请补 wrapper 或装 Maven）')
      else {
        const sp = spinner(`后端构建 ${c.dim(`（${mvn.note}，首次下载依赖较久）`)}`)
        sp.start()
        const r = run(mvn.cmd, mvn.args, { cwd: serverDir, timeout: 0 })
        if (r.ok) sp.succeed('后端构建通过')
        else {
          sp.fail('后端构建失败')
          out(c.dim(indent(r.out.trim().split(/\r?\n/).slice(-15).join('\n'), 4)))
          pending.push('后端构建失败，详见上方日志')
        }
      }
    }

    const webDir = path.join(adminDir, 'web')
    const hasPnpm = env.find((e) => e.key === 'pnpm').status === 'ok'
    if (!existsSync(webDir)) pending.push('前端未安装依赖：projects/iwan-admin/web 不存在')
    else if (!hasPnpm && !which('corepack')) pending.push('前端未安装依赖：pnpm 与 corepack 均不可用')
    else {
      const sp = spinner('前端依赖安装')
      sp.start()
      const [cmd, args] = hasPnpm ? ['pnpm', ['install', '--silent']] : ['corepack', ['pnpm', 'install', '--silent']]
      const r = run(cmd, args, { cwd: webDir, timeout: 0 })
      if (r.ok) sp.succeed('前端依赖就绪')
      else {
        sp.fail('前端依赖安装失败')
        out(c.dim(indent(r.out.trim().split(/\r?\n/).slice(-15).join('\n'), 4)))
        pending.push('前端依赖安装失败，详见上方日志')
      }
    }
  }

  /* 11) 收尾 ------------------------------------------------------------ */
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  out()
  if (cloneFailed.length) {
    fail(`以下仓库克隆失败：${cloneFailed.map((f) => `${f.name}${c.dim(`（${f.repo}）`)}`).join('、')}`)
    note(`  重跑同目录会自动跳过已存在的仓库：npx github:iwantools/create-iwantools --dir "${dir}"`)
  }
  for (const p of pending) warn(p)

  const okAll = cloneFailed.length === 0 && bad === 0
  if (okAll) {
    ok(`${c.bold('工作空间就绪')} ${c.dim(`${secs}s`)}`)
    out(`  ${c.dim(sym.dot)} 仓库 ${manifest.length}/${manifest.length} ${c.dim(sym.dot)} 校验 ${doCheck ? '通过' : '跳过'} ${c.dim(sym.dot)} skills ${doSkills ? '已同步' : '跳过'} ${c.dim(sym.dot)} ${levelText}`)
  } else {
    warn(`${c.bold('部分完成')} ${c.dim(`${secs}s`)}`)
  }

  out()
  out(`  ${c.bold('接下来')}`)
  out(`  ${c.cyan('$')} cd ${dir}`)
  out(`  ${c.dim('# 会话开在此目录，对 AI 说「继续」即可接上现场')}`)
  if (level !== 'skip') {
    out(`  ${c.dim('# 后端启动需要两个 dev secret，见 docs/onboarding.md 第 5 节')}`)
    out(`  ${c.cyan('$')} VITE_API_PROXY_TARGET=http://localhost:8090 pnpm dev   ${c.dim('# 在 projects/iwan-admin/web')}`)
  }
  out(`  ${c.dim('# 首次访问 http://127.0.0.1:5173 →「初始化入口」创建超级管理员')}`)
  out()

  return okAll ? 0 : 1
}

const canonicalize = (repo) => c.cyan(repo)
const indent = (text, n) =>
  String(text)
    .split(/\r?\n/)
    .map((l) => `${' '.repeat(n)}${l}`)
    .join('\n')

/**
 * 是否被直接执行。
 *
 * 不能用 `path.resolve(argv[1]) === fileURLToPath(import.meta.url)`：经
 * `node_modules/.bin/*` 这类符号链接启动时，argv[1] 是链接路径，而 import.meta.url
 * 已被 Node 解成真实路径，两者永不相等 —— 表现为 `npx github:…` 一声不响退出 0。
 * 因此两边都先 realpath 再比；仍不相等时按文件名兜底，兼容 .cmd/.ps1 垫片与打包器。
 */
const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(import.meta.url)
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  if (real(entry) === real(self)) return true
  return path.basename(entry).replace(/\.(?:[cm]?js|[cm]?ts|cmd|bat|ps1)$/i, '') === 'create-iwantools'
})()

if (isMain) {
  try {
    process.exitCode = await main()
  } catch (error) {
    fail(String(error?.message || error))
    if (process.env.DEBUG) out(String(error?.stack))
    process.exitCode = 1
  }
}
