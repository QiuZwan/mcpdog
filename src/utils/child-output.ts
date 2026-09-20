/**
 * 子进程输出的编码解码。
 *
 * 背景：子进程的 stderr 来自两类程序，编码不同 ——
 * - cmd.exe 及本机工具：按**控制台 OEM 代码页**输出（中文 Windows 是 936/GBK）；
 * - Node 程序（如 @playwright/mcp）：按 UTF-8 输出。
 *
 * 此前无条件 `data.toString()`（UTF-8），于是 GBK 的中文全变成 U+FFFD 且**原始字节不可恢复**。
 * 线上那次 playwright 连不上的排查，时间几乎全花在这一条上：子进程明明说了
 * 「系统找不到指定的路径。」，日志里只剩一串问号。
 *
 * 这里按行解码（在字节层按 \n 切分，避免跨 chunk 的多字节状态），并对每行
 * 先严格试 UTF-8、失败再按 OEM 代码页 —— 两类程序都能正确还原。
 */

import { execFileSync } from 'child_process';

/**
 * OEM 代码页号 → TextDecoder 的编码标签。
 * 只覆盖常见取值；未知返回 null，由调用方回退 UTF-8（宁可有替换字符，也不抛错）。
 */
export function codePageToEncoding(codePage: number): string | null {
  switch (codePage) {
    case 936:
      return 'gbk';
    case 950:
      return 'big5';
    case 932:
      return 'shift_jis';
    case 949:
      return 'euc-kr';
    case 874:
      return 'windows-874';
    case 1250:
      return 'windows-1250';
    case 1251:
      return 'windows-1251';
    case 1252:
      return 'windows-1252';
    case 65001:
      return 'utf-8';
    default:
      return null;
  }
}

let cachedCodePage: number | null | undefined;

/**
 * 当前控制台 OEM 代码页（仅 Windows；读取失败或非 Windows 返回 null）。
 * 只读一次并缓存 —— `chcp.com` 是起进程，不该在每行 stderr 上做。
 */
export function getOemCodePage(): number | null {
  if (cachedCodePage !== undefined) return cachedCodePage;
  cachedCodePage = null;
  if (process.platform === 'win32') {
    try {
      // 输出形如「活动代码页: 936」/「Active code page: 936」，取末尾数字，避免依赖本地化文案
      const out = execFileSync('chcp.com', [], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      const matched = String(out).match(/(\d{3,5})\s*$/m);
      if (matched) cachedCodePage = parseInt(matched[1], 10);
    } catch {
      // 读不到就回退 UTF-8
    }
  }
  return cachedCodePage;
}

/** 用指定编码严格解码；失败（含非法字节序列）返回 null，不抛错 */
export function tryDecodeStrict(bytes: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 解码子进程输出的一行（已按 \n 切好的完整行），使用显式给出的代码页。
 *
 * 与 `decodeChildLine` 分开是为了可确定性测试：OEM 代码页取决于运行机器
 * （中文 Windows 是 936，英文可能是 437），把代码页作为参数才能让用例在任何机器上一致。
 *
 * 判定顺序：严格 UTF-8 → 指定 OEM 代码页 → 宽松 UTF-8 兜底。
 * 先试 UTF-8 是因为 Node 型子服务器（占多数）就发 UTF-8，而 GBK 的中文字节序列
 * 基本都不是合法 UTF-8，所以这个顺序不会把两类搞混。
 */
export function decodeChildLineWith(bytes: Buffer, codePage: number | null): string {
  const asUtf8 = tryDecodeStrict(bytes, 'utf-8');
  if (asUtf8 !== null) return asUtf8;

  const label = codePage === null ? null : codePageToEncoding(codePage);
  if (label) {
    const asOem = tryDecodeStrict(bytes, label);
    if (asOem !== null) return asOem;
  }

  // 两种都不成立：宽松 UTF-8，保留替换字符但不丢整行
  return bytes.toString('utf-8');
}

/** 解码子进程输出的一行，OEM 代码页取自当前机器 */
export function decodeChildLine(bytes: Buffer): string {
  return decodeChildLineWith(bytes, getOemCodePage());
}
