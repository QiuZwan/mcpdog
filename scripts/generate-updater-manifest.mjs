/**
 * 生成 Tauri updater 的静态清单 latest.json。
 *
 * 为什么需要这个脚本：`tauri build` 只产出安装包和它的 .sig，**不产出 latest.json**。
 * 官方文档把 latest.json 归给 tauri-action（"Tauri Action generates a static JSON file"），
 * CLI 二进制里既没有该文件名也没有清单必需的 pub_date 字段 —— 实测 `npx @tauri-apps/cli build`
 * 的产物只有 bundle/nsis/*.exe 与 *.exe.sig。
 *
 * 而自更新端点指向 releases/latest/download/latest.json：Release 里缺这个文件时，
 * 客户端拿到的是 404，失败方式是完全无提示的（永远「已是最新」）。所以这里显式把它拼出来，
 * 且本地 `shell:package` 与 CI 走同一段逻辑，避免两边产物不一致。
 *
 * 字段对齐 tauri-plugin-updater 的 RemoteRelease（Static 形态）：
 * version / pub_date / platforms.<target>.{url,signature}；pubkey 一并写入便于人工核对。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const BUNDLE_DIR = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
const NSIS_DIR = path.join(BUNDLE_DIR, 'nsis');
const OUT_FILE = path.join(BUNDLE_DIR, 'latest.json');

// Windows 上客户端按 `{os}-{arch}` 查找平台键（bundle_type 探测失败时也会回退到这个键），
// 所以平台键固定为 windows-x86_64，而不是 windows-x86_64-nsis。
const TARGET = 'windows-x86_64';

function fail(message) {
  throw new Error(`生成 latest.json 失败：${message}`);
}

const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
const version = conf.version;
const pubkey = conf.plugins?.updater?.pubkey;
const endpoints = conf.plugins?.updater?.endpoints ?? [];

if (!version) {
  fail('src-tauri/tauri.conf.json 缺少 version');
}

// 下载地址用的是 tauri.conf.json 的版本，但 CI 上资产实际发布到「触发本次运行的 tag」对应的
// release。两者不一致时（例如预发布 tag `v1.1.0-rc.1` 配版本 `1.1.0`）清单会指向一个不存在的
// tag，而那个 release 仍会成为 releases/latest —— 已装客户端从此 404 并永远静默报「已是最新」。
// 本地运行没有 GITHUB_REF_NAME，不受影响；CI 上不一致就让这一步变红。
const refName = process.env.GITHUB_REF_NAME;
if (refName && refName !== `v${version}`) {
  fail(`GITHUB_REF_NAME=${refName} 与 tauri.conf.json 的版本不一致（期望 v${version}）`);
}

if (!pubkey) {
  fail('src-tauri/tauri.conf.json 的 plugins.updater.pubkey 为空，自更新无法验签');
}
if (endpoints.length === 0) {
  fail('src-tauri/tauri.conf.json 的 plugins.updater.endpoints 为空');
}

// 资源 URL 必须与 endpoint 指向同一个仓库，否则清单里给出的下载地址会 404。
// 从 endpoint 推导仓库前缀，避免出现「两处各写一个仓库地址」的漂移。
const endpoint = endpoints[0];
const repoMatch = endpoint.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\//);
if (!repoMatch) {
  fail(`无法从 endpoint 推导 GitHub 仓库前缀：${endpoint}`);
}
const repoBase = repoMatch[1];

if (!existsSync(NSIS_DIR)) {
  fail(`未找到 ${path.relative(ROOT, NSIS_DIR)}，请先跑 npm run shell:package`);
}

// 目录里应当只有一个安装包；多出来说明有陈旧产物，宁可报错也不猜哪个是对的。
const installers = readdirSync(NSIS_DIR).filter((f) => f.endsWith('-setup.exe'));
if (installers.length !== 1) {
  fail(`期望 ${path.relative(ROOT, NSIS_DIR)} 下恰好一个 *-setup.exe，实际 ${installers.length} 个：${installers.join(', ')}`);
}
const installerName = installers[0];

// 版本三处必须同步，这里以安装包文件名反查一次，防止清单版本与包内实际版本不一致。
if (!installerName.includes(`_${version}_`)) {
  fail(`安装包文件名 ${installerName} 与 tauri.conf.json 的版本 ${version} 不一致`);
}

const sigPath = path.join(NSIS_DIR, `${installerName}.sig`);
if (!existsSync(sigPath)) {
  fail(`缺少签名文件 ${path.relative(ROOT, sigPath)}（需要 TAURI_SIGNING_PRIVATE_KEY）`);
}
const signature = readFileSync(sigPath, 'utf8').trim();
if (!signature) {
  fail(`签名文件 ${path.relative(ROOT, sigPath)} 为空`);
}

// 用 tag 固定资源地址（而不是 releases/latest/download/）：清单自身的 version 与
// 它指向的安装包必须是同一次构建，走 latest 会在发布下一个版本后错配。
const url = `${repoBase}/releases/download/v${version}/${installerName}`;

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  pubkey,
  platforms: {
    [TARGET]: {
      signature,
      url,
    },
  },
};

writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log('已生成 updater 清单:', path.relative(ROOT, OUT_FILE));
console.log(`  version   ${version}`);
console.log(`  target    ${TARGET}`);
console.log(`  url       ${url}`);
console.log(`  signature ${signature.slice(0, 32)}... (${signature.length} 字符)`);
