/**
 * 为桌面壳准备内嵌资源：完整 Node 分发 + 构建产物。
 *
 * 产物落在 src-tauri/resources/（已在 .gitignore 中），由 tauri.conf.json 的
 * bundle.resources 打进 NSIS 安装包。Node 版本在此固定，升级时改这一处常量。
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const NODE_VERSION = '22.14.0'; // 固定 LTS；与 package.json engines 的 >=18 兼容
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = path.join(ROOT, 'src-tauri', 'resources');
const CACHE = path.join(ROOT, '.cache', 'node-dist');
// 解压目录必须与 zip 分开：extractZip 会先清空目标目录，
// 若目标目录同时存放 zip，zip 会在解压前被自己删掉。
const EXTRACT_DIR = path.join(CACHE, 'extract');

function assertBuilt() {
  for (const p of ['dist/cli/cli-main.js', 'web/dist/index.html']) {
    const full = path.join(ROOT, p);
    if (!existsSync(full)) {
      throw new Error(`缺少构建产物 ${p}，请先执行 npm run build`);
    }
  }
}

async function download(url, dest) {
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function ensureNodeZip() {
  mkdirSync(CACHE, { recursive: true });
  const fileName = `node-v${NODE_VERSION}-win-x64.zip`;
  const zipPath = path.join(CACHE, fileName);
  const expected = await fetchExpectedSha256(fileName);

  if (existsSync(zipPath)) {
    // 缓存命中也必须校验：只按 existsSync 接受会把「中断下载留下的截断文件」
    // 永久固化，之后每次都在 Expand-Archive 里以难懂的 PowerShell 报错失败。
    verifySha256(zipPath, expected);
    console.log(`复用缓存且校验通过 ${path.relative(ROOT, zipPath)}`);
  } else {
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${fileName}`, zipPath);
    verifySha256(zipPath, expected);
  }
  return zipPath;
}

// 取上游官方校验和：这是本脚本唯一从网络取回、并随安装器再分发给用户的二进制
async function fetchExpectedSha256(fileName) {
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载校验和失败 HTTP ${res.status}: ${url}`);
  const text = await res.text();
  // 格式：<64 位十六进制 sha256>  两空格  <文件名>
  for (const line of text.split('\n')) {
    const matched = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (matched && matched[2].trim() === fileName) return matched[1].toLowerCase();
  }
  throw new Error(`校验和文件中找不到 ${fileName}：${url}`);
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function verifySha256(filePath, expected) {
  const actual = sha256File(filePath);
  if (actual !== expected) {
    // 删掉坏文件，否则下次仍会命中缓存并永远失败
    rmSync(filePath, { force: true });
    throw new Error(
      `Node 分发包校验失败，已删除以便重试：${filePath}\n  期望 sha256: ${expected}\n  实际 sha256: ${actual}`,
    );
  }
}

function extractZip(zipPath, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  // 用 PowerShell 解压，避免引入 zip 依赖
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
    { stdio: 'inherit' },
  );
}

async function main() {
  assertBuilt();

  const zipPath = await ensureNodeZip();
  const unpackDir = path.join(EXTRACT_DIR, `node-v${NODE_VERSION}-win-x64`);
  extractZip(zipPath, EXTRACT_DIR);
  // 先确认解压结果再动 resources：归档顶层目录名若变化，应给出可读诊断，
  // 而不是裸 ENOENT，更不该先把上一份可用产物删掉
  if (!existsSync(unpackDir)) {
    throw new Error(`解压后未找到 Node 目录 ${unpackDir}（归档顶层目录名可能已变化）`);
  }

  // 1) 内嵌 Node 分发（含 npm/npx）
  const nodeTarget = path.join(RESOURCES, 'node');
  rmSync(nodeTarget, { recursive: true, force: true });
  mkdirSync(nodeTarget, { recursive: true });
  cpSync(unpackDir, nodeTarget, { recursive: true });
  if (!existsSync(path.join(nodeTarget, 'node.exe'))) {
    throw new Error(`内嵌 Node 缺少 node.exe：${nodeTarget}`);
  }
  if (!existsSync(path.join(nodeTarget, 'npm.cmd'))) {
    throw new Error(`内嵌 Node 缺少 npm.cmd（子服务器依赖 npx）：${nodeTarget}`);
  }
  if (!existsSync(path.join(nodeTarget, 'npx.cmd'))) {
    throw new Error(`内嵌 Node 缺少 npx.cmd（子服务器以 npx 启动，内嵌完整分发的前提）：${nodeTarget}`);
  }

  // 2) daemon 应用（dist + 前端产物 + package.json 供版本号读取）
  const appTarget = path.join(RESOURCES, 'app');
  rmSync(appTarget, { recursive: true, force: true });
  mkdirSync(appTarget, { recursive: true });
  cpSync(path.join(ROOT, 'dist'), path.join(appTarget, 'dist'), { recursive: true });
  mkdirSync(path.join(appTarget, 'web'), { recursive: true });
  cpSync(path.join(ROOT, 'web', 'dist'), path.join(appTarget, 'web', 'dist'), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(appTarget, 'package.json'));

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  writeFileSync(
    path.join(RESOURCES, 'VERSION'),
    `${pkg.version}\n`,
    'utf-8',
  );

  console.log('内嵌资源准备完成:');
  console.log(`  Node ${NODE_VERSION} -> ${path.relative(ROOT, nodeTarget)}`);
  console.log(`  App ${pkg.version}    -> ${path.relative(ROOT, appTarget)}`);
}

main().catch((error) => {
  console.error(`准备内嵌资源失败: ${error.message}`);
  process.exit(1);
});
