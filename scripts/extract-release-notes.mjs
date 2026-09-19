/**
 * 从 CHANGELOG.md 抽出当前 package.json 版本对应的条目，用于生成 Release notes。
 * 约定：条目以 `## [<version>]` 开头，到下一个 `## [` 或文件结尾为止。
 *
 * 用法：node scripts/extract-release-notes.mjs > release-notes.md
 *
 * 实现说明：刻意用逐行扫描而不是正则捕获整段。初版写成
 * `(?=^##\s*\[|\z)`，而 `\z` 是 Perl/PCRE 的「输入结尾」锚点，**JavaScript 没有它** ——
 * 在 JS 里 `\z` 退化成字面字符 `z`，于是条目会在正文里第一个字母 z 处被截断
 * （实测：notes 断在 `headers.Authori`）。逐行扫描没有这类锚点语义可踩。
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sectionHead = new RegExp(`^##\\s*\\[${escapeRe(version)}\\]`);
const anySectionHead = /^##\s*\[/;

const lines = changelog.split(/\r?\n/);

const start = lines.findIndex((line) => sectionHead.test(line));
if (start === -1) {
  // 找不到条目时不要静默产出空 notes —— 那会让 Release 看起来像「本次无变更」
  console.error(`CHANGELOG.md 中找不到版本 ${version} 的条目（期望形如 "## [${version}]"）`);
  process.exit(1);
}

// 从条目下一行起，到下一个 `## [` 之前
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (anySectionHead.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md 中 ${version} 的条目为空`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
