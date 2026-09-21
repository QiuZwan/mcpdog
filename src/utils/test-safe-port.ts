import { createServer, Server as NetServer } from 'net';
import type { AddressInfo } from 'net';

/**
 * 测试用：取一个 **fetch 可用**的随机端口。
 *
 * 直接 `server.listen(0)` 拿到的端口可能落在 WHATWG 阻止端口表里
 * （Node 的 fetch/undici 会直接以 `bad port` 失败，而这些端口本身是可正常绑定的）。
 * 本机的动态端口范围（1024–14999）与那张表有交集，因此这类测试会随机失败。
 * 这里显式跳过被阻止的端口，让测试不再看运气。
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
  102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** 取一个 fetch 可用的空闲端口（已释放，调用方可立即据此起服务） */
export async function getFetchSafePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe: NetServer = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      return port;
    }
  }
  throw new Error('无法取到 fetch 可用的测试端口');
}
