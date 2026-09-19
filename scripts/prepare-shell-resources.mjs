/**
 * 为桌面壳准备内嵌资源：完整 Node 分发 + 构建产物。
 *
 * 产物落在 src-tauri/resources/（已在 .gitignore 中），由 tauri.conf.json 的
 * bundle.resources 打进 NSIS 安装包。Node 版本在此固定，升级时改这一处常量。
 */

import { execFileSync, execSync } from 'child_process';
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

/**
 * 把 daemon 的生产依赖装进 resources/app。
 *
 * 为什么必须装：daemon 的 import 图是裸说明符 ESM（cross-spawn / axios / eventsource /
 * express / socket.io / cors 等）。Node 按「导入文件所在目录」向上找 node_modules，
 * 开发态能找到仓库根的 node_modules，但 NSIS 装到 C:\Program Files\MCPDog\ 之后，
 * 向上只能走到 C:\ —— 找不到包，daemon 在模块加载阶段就退出。安装包体积只有 ~27MB
 * 正是「一个依赖都没带」的旁证，而壳的全部价值都押在这个进程上。
 *
 * 用 `npm ci --omit=dev` 而不是 esbuild 打包：锁文件即安装内容，与仓库依赖完全一致，
 * 不需要为 daemon 维护第二份打包配置；npm 本来就是构建本仓库的前提。
 * 子服务器走 npx 自行下载，不在这个 node_modules 的范围内。
 */
function installAppDependencies(appTarget) {
  // 锁文件必须与 package.json 一起进去：`npm ci` 只按锁文件安装，且缺锁文件会直接失败。
  cpSync(path.join(ROOT, 'package-lock.json'), path.join(appTarget, 'package-lock.json'));

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('安装 daemon 生产依赖 (npm ci --omit=dev) ...');
  try {
    // 必须走 shell：Windows 上直接 spawn `npm.cmd` 会以 EINVAL 失败
    // （Node 的 CVE-2024-27980 修复后禁止无 shell 执行批处理）。
    // 命令串是常量，不存在注入面。execSync 用单个字符串，避免 execFileSync + args +
    // shell 触发的 DEP0190 告警。
    execSync(`${npm} ci --omit=dev`, {
      cwd: appTarget,
      stdio: 'inherit',
      // 跳过 puppeteer / playwright 的浏览器下载：它们不在 daemon 的 import 图里
      // （子服务器由 npx 自行取包），但 postinstall 会额外拉数百 MB 浏览器，
      // 拖慢每次打包、也会污染构建机的缓存目录。
      env: {
        ...process.env,
        PUPPETEER_SKIP_DOWNLOAD: '1',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      },
    });
  } catch (error) {
    throw new Error(`安装 daemon 生产依赖失败（${error.message}）；resources/app 无法独立启动 daemon`);
  }

  // 没有 node_modules 的产物必然在安装后报 ERR_MODULE_NOT_FOUND，这里前置拦下，
  // 避免把一个「装完但起不来」的安装包发出去。
  if (!existsSync(path.join(appTarget, 'node_modules'))) {
    throw new Error(`npm ci 未产出 ${path.join(appTarget, 'node_modules')}`);
  }
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

  // 3) 生产依赖：没有它 resources/app 在仓库外无法加载 daemon（裸说明符 ESM 解析不到包）
  installAppDependencies(appTarget);

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
