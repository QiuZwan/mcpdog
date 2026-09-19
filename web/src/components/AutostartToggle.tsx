import React, { useEffect, useState } from 'react';
import { Power } from 'lucide-react';
import { apiClient } from '../utils/api';

/**
 * 开机自启开关。写什么由 daemon 裁决（见 src/utils/autostart.ts）：桌面版接管时
 * 指向壳 exe，CLI 用法时指向 daemon 命令行 —— 前端不需要区分这两种形态。
 */
export const AutostartToggle: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(true);
  const [form, setForm] = useState<string>('none');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiClient
      .get('/api/autostart')
      .then((d: any) => {
        setEnabled(!!d?.enabled);
        setSupported(d?.supported !== false);
        setForm(String(d?.form ?? 'none'));
      })
      .catch(() => {
        // 非 Windows 或接口不可用时隐藏开关，不影响主界面
        setSupported(false);
      });
  }, []);

  if (!supported) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      const d: any = await apiClient.put('/api/autostart', { enabled: !enabled });
      setEnabled(!!d?.enabled);
      setForm(String(d?.form ?? 'none'));
    } catch (error) {
      // 失败必须让用户看见：只写 console.error 时点电源图标等于什么都没发生。
      // 这里保留原状态（成功才 setEnabled），并弹出原因 —— 与 AddServerModal /
      // ServerPanel 的既有做法一致（本项目没有 toast 系统）。
      const reason = error instanceof Error ? error.message : String(error);
      alert(`切换开机自启失败：\n\n${reason}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={form === 'shell' ? '开机自启（由桌面版接管）' : '开机自启'}
      className="btn btn-ghost btn-sm !text-white"
    >
      <Power className={`h-4 w-4 ${enabled ? '' : 'opacity-50'}`} />
    </button>
  );
};
