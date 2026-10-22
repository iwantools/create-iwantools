/**
 * 跨平台回归测试（node:test，零依赖）：npm test
 * 覆盖那些「在 macOS 上跑不出来、但 Windows 上必炸」的分支。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const mod = await import('../bin/create-iwantools.js')
const { invocationOf, readTsv, javaMajor, mavenInvocation } = mod

test('invocationOf：非 Windows 直通，不改参数', () => {
  const r = invocationOf('/usr/local/bin/pnpm', ['install', '--silent'], { isWin: false, resolved: '/usr/local/bin/pnpm' })
  assert.equal(r.file, '/usr/local/bin/pnpm')
  assert.deepEqual(r.argv, ['install', '--silent'])
})

test('invocationOf：Windows .cmd 垫片经 cmd.exe，含空格路径正确加引号', () => {
  const shim = 'C:\\Program Files\\nodejs\\pnpm.cmd'
  const r = invocationOf(shim, ['install', '--silent'], { isWin: true, resolved: shim })
  assert.match(r.file, /cmd\.exe$/i)
  assert.equal(r.argv[0], '/d')
  assert.equal(r.argv[1], '/s')
  assert.equal(r.argv[2], '/c')
  // cmd /s 会剥掉最外层引号，因此形如 ""C:\a b\x.cmd" install --silent"
  assert.equal(r.argv[3], `""${shim}" install --silent"`)
})

test('invocationOf：Windows .exe 不受影响', () => {
  const exe = 'C:\\Program Files\\Git\\cmd\\git.exe'
  const r = invocationOf('git', ['--version'], { isWin: true, resolved: exe })
  assert.equal(r.file, exe)
  assert.deepEqual(r.argv, ['--version'])
})

test('readTsv：CRLF、BOM、注释、空字段、缺列全部安全', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ciw-tsv-'))
  const file = path.join(dir, 'repos.tsv')
  writeFileSync(
    file,
    '\uFEFFname\trepository\tpath\tupstream\trequired\r\n' +
      '# 注释行\r\n' +
      'iwan-admin\tiwantools/iwan-admin\tprojects/iwan-admin\t\tfalse\r\n' +
      'iwantools-site-ops\tiwantools/iwantools-site-ops\tprojects/iwantools-site-ops\tiwantools/iwan-admin\r\n' +
      '\r\n',
  )
  const rows = readTsv(file)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'iwan-admin')
  assert.equal(rows[0].upstream, '')
  assert.equal(rows[0].required, 'false')
  assert.equal(rows[1].required, '')
  assert.equal(rows[1].upstream, 'iwantools/iwan-admin')
})

test('javaMajor：各厂商输出都能取到主版本', () => {
  assert.equal(javaMajor('openjdk version "21.0.11" 2026-04-21 LTS'), 21)
  assert.equal(javaMajor('openjdk 21.0.2 2024-01-16'), 21)
  assert.equal(javaMajor('java version "1.8.0_392"'), 8)
  assert.equal(javaMajor('openjdk version "17" 2021-09-14'), 17)
  assert.equal(javaMajor('garbage'), 0)
})

test('mavenInvocation：Windows 有 mvnw.cmd 时优先用它', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ciw-mvn-'))
  writeFileSync(path.join(dir, 'mvnw.cmd'), '@echo off\r\n')
  const r = mavenInvocation(dir, { isWin: true, hasBin: () => true })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.cmd, path.join(dir, 'mvnw.cmd'))
  assert.deepEqual(r.args, ['-q', '-DskipTests', 'install'])
})

test('mavenInvocation：Windows 只有 mvnw（无 .cmd）时退回系统 mvn，而不是 hardcode ./mvnw', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ciw-mvn-'))
  writeFileSync(path.join(dir, 'mvnw'), '#!/bin/sh\n')
  const r = mavenInvocation(dir, { isWin: true, hasBin: (b) => b === 'mvn' })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.cmd, 'mvn')
  assert.match(r.note, /mvnw\.cmd/)
})

test('mavenInvocation：Windows 无 mvn 也无 .cmd 时用 bash 跑 mvnw（最后手段）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ciw-mvn-'))
  writeFileSync(path.join(dir, 'mvnw'), '#!/bin/sh\n')
  const r = mavenInvocation(dir, { isWin: true, hasBin: () => false })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.cmd, 'bash')
  assert.deepEqual(r.args, [path.join(dir, 'mvnw'), '-q', '-DskipTests', 'install'])
})

test('mavenInvocation：Linux/macOS 直接用 ./mvnw', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ciw-mvn-'))
  writeFileSync(path.join(dir, 'mvnw'), '#!/bin/sh\n')
  const r = mavenInvocation(dir, { isWin: false, hasBin: () => true })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.cmd, path.join(dir, 'mvnw'))
})

test('mavenInvocation：什么都没有时返回 null（由调用方给出可操作提示）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ciw-mvn-'))
  mkdirSync(path.join(dir, 'sub'))
  const r = mavenInvocation(dir, { isWin: true, hasBin: () => false })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r, null)
})
