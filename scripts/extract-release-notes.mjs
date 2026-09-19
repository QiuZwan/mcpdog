/**
 * 从 CHANGELOG.md 抽出当前 package.json 版本对应的条目，用于生成 Release notes。
 * 约定：条目以 `## [<version>]` 开头，到下一个 `## [` 或文件结尾为止。
 *
 * 用法：node scripts/extract-release-notes.mjs > release-notes.md
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sectionRe = new RegExp(
  `^##\\s*\\[${escapeRe(version)}\\][^\\n]*\\n([\\s\\S]*?)(?=^##\\s*\\[|\\z)`,
  'm',
);

const match = changelog.match(sectionRe);
if (!match) {
  // 找不到条目时不要静默产出空 notes —— 那会让 Release 看起来像「本次无变更」
  console.error(`CHANGELOG.md 中找不到版本 ${version} 的条目（期望形如 "## [${version}]"）`);
  process.exit(1);
}

const body = match[1].trim();
if (!body) {
  console.error(`CHANGELOG.md 中 ${version} 的条目为空`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
