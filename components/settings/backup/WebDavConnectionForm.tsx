import { useRef, useState } from 'react';
import { Loader2, PlugZap } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { testConnection, webdavErrorMessage, assertValidBaseUrl } from '@/lib/backup/webdav';
import type { WebDavConfig } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface WebDavConnectionFormProps {
  /** 已保存的连接配置；首次配置为 null。表单据此初始化草稿。 */
  initial: WebDavConfig | null;
  /** 用户保存（校验通过的）连接配置时回调，由父级负责持久化。 */
  onSave: (config: WebDavConfig) => void;
  /** 可选取消（编辑已有连接时显示）。 */
  onCancel?: () => void;
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok' }
  | { status: 'error'; message: string };

/** 去掉首尾空白后组装草稿配置。 */
function draftConfig(url: string, username: string, password: string, directory: string): WebDavConfig {
  return {
    url: url.trim(),
    username: username.trim(),
    password,
    directory: directory.trim(),
  };
}

/**
 * WebDAV 连接配置表单：URL / 用户名 / 密码 / 远程目录 + 「测试连接」。测试连接只读探测
 * 远程目录、不写任何东西；保存由父级持久化到 webdavConfig（密钥类，可被加密备份带走）。
 */
export function WebDavConnectionForm({ initial, onSave, onCancel }: WebDavConnectionFormProps) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState(initial?.password ?? '');
  const [directory, setDirectory] = useState(initial?.directory ?? '/cebian');
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  // 测试连接是异步的；每次改字段都自增「代」，让在途的旧请求结果作废，避免它在用户
  // 已改动表单后回填出过时的「连接正常 / 失败」。
  const testGen = useRef(0);

  const canSubmit = url.trim().length > 0;

  // 改任一字段：作废在途测试、清掉上次结果。
  const resetTest = () => {
    testGen.current += 1;
    setTest({ status: 'idle' });
  };

  const handleTest = async () => {
    if (!canSubmit) return;
    const gen = ++testGen.current;
    setTest({ status: 'testing' });
    try {
      await testConnection(draftConfig(url, username, password, directory));
      if (gen === testGen.current) setTest({ status: 'ok' });
    } catch (err) {
      if (gen === testGen.current) setTest({ status: 'error', message: webdavErrorMessage(err) });
    }
  };

  const handleSave = () => {
    if (!canSubmit) return;
    const config = draftConfig(url, username, password, directory);
    // 保存前校验地址：不点「测试连接」直接保存也要挡住带账号 / 参数的非法 URL，
    // 否则会被存进配置并显示在连接概要里（泄露）。失败复用 test 的错误展示。
    try {
      assertValidBaseUrl(config.url);
    } catch (err) {
      setTest({ status: 'error', message: webdavErrorMessage(err) });
      return;
    }
    onSave(config);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="webdav-url" className="text-xs">{t('settings.backup.webdav.urlLabel')}</Label>
        <Input
          id="webdav-url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); resetTest(); }}
          placeholder={t('settings.backup.webdav.urlPlaceholder')}
          className="h-8 text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="webdav-user" className="text-xs">{t('settings.backup.webdav.usernameLabel')}</Label>
          <Input
            id="webdav-user"
            value={username}
            onChange={(e) => { setUsername(e.target.value); resetTest(); }}
            placeholder={t('settings.backup.webdav.usernamePlaceholder')}
            className="h-8 text-sm"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webdav-pass" className="text-xs">{t('settings.backup.webdav.passwordLabel')}</Label>
          <Input
            id="webdav-pass"
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); resetTest(); }}
            placeholder={t('settings.backup.webdav.passwordPlaceholder')}
            className="h-8 text-sm"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="webdav-dir" className="text-xs">{t('settings.backup.webdav.directoryLabel')}</Label>
        <Input
          id="webdav-dir"
          value={directory}
          onChange={(e) => { setDirectory(e.target.value); resetTest(); }}
          placeholder={t('settings.backup.webdav.directoryPlaceholder')}
          className="h-8 text-sm"
        />
      </div>

      {test.status === 'ok' && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {t('settings.backup.webdav.testSuccess')}
        </p>
      )}
      {test.status === 'error' && (
        <p className="text-xs text-destructive">{test.message}</p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          onClick={handleTest}
          disabled={!canSubmit || test.status === 'testing'}
        >
          {test.status === 'testing'
            ? <Loader2 className={cn('size-4 animate-spin')} />
            : <PlugZap className="size-4" />}
          {t('settings.backup.webdav.test')}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSubmit}>
          {t('settings.backup.webdav.save')}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
