import { describe, it, expect } from 'vitest';
import {
  codePageToEncoding,
  tryDecodeStrict,
  decodeChildLineWith,
} from './child-output.js';

// 线上事故（playwright 连不上）里子进程 stderr 的原始字节：
// cmd.exe 按 GBK 输出的「系统找不到指定的路径。」
const INCIDENT_BYTES = Buffer.from(
  'cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4c2b7beb6a1a3',
  'hex',
);

describe('codePageToEncoding', () => {
  it('常见 OEM 代码页映射正确', () => {
    expect(codePageToEncoding(936)).toBe('gbk');
    expect(codePageToEncoding(950)).toBe('big5');
    expect(codePageToEncoding(932)).toBe('shift_jis');
    expect(codePageToEncoding(65001)).toBe('utf-8');
  });

  it('未知代码页返回 null（调用方回退 UTF-8）', () => {
    expect(codePageToEncoding(437)).toBeNull();
    expect(codePageToEncoding(99999)).toBeNull();
  });
});

describe('tryDecodeStrict', () => {
  it('合法 UTF-8 解码成功', () => {
    expect(tryDecodeStrict(Buffer.from('hello 中文', 'utf8'), 'utf-8')).toBe('hello 中文');
  });

  it('非法字节序列返回 null 而不是抛错', () => {
    expect(tryDecodeStrict(INCIDENT_BYTES, 'utf-8')).toBeNull();
  });

  it('同一段 GBK 字节用 gbk 解码成功', () => {
    expect(tryDecodeStrict(INCIDENT_BYTES, 'gbk')).toBe('系统找不到指定的路径。');
  });
});

describe('decodeChildLineWith', () => {
  it('还原线上那条 cmd 报错（这是本次修复的直接目的）', () => {
    expect(decodeChildLineWith(INCIDENT_BYTES, 936)).toBe('系统找不到指定的路径。');
  });

  it('Node 型子服务器的 UTF-8 stderr 不被按 GBK 弄坏', () => {
    const utf8 = Buffer.from('Error: browser not found 浏览器未安装', 'utf8');
    // 即使机器 OEM 是 936，也必须优先按 UTF-8 正确还原
    expect(decodeChildLineWith(utf8, 936)).toBe('Error: browser not found 浏览器未安装');
  });

  it('纯 ASCII 两种编码下结果一致', () => {
    const ascii = Buffer.from('spawn npx ENOENT', 'utf8');
    expect(decodeChildLineWith(ascii, 936)).toBe('spawn npx ENOENT');
    expect(decodeChildLineWith(ascii, null)).toBe('spawn npx ENOENT');
  });

  it('代码页为 null 时 GBK 内容退化为宽松 UTF-8（保留替换字符，不抛错、不丢整行）', () => {
    const decoded = decodeChildLineWith(INCIDENT_BYTES, null);
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded).not.toBe('系统找不到指定的路径。');
  });

  it('未知代码页时同样退化为宽松 UTF-8', () => {
    const decoded = decodeChildLineWith(INCIDENT_BYTES, 437);
    expect(decoded.length).toBeGreaterThan(0);
  });

  it('空行不抛错', () => {
    expect(decodeChildLineWith(Buffer.alloc(0), 936)).toBe('');
  });
});
