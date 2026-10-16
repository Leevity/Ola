import { useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AlertCircle, Check, LockKeyhole } from 'lucide-react'
import { getThemePresetDefinition } from '@renderer/lib/theme-presets'
import { OlaBrand } from '@renderer/components/brand/OlaBrand'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Alert, AlertTitle, AlertDescription } from '@renderer/components/ui/alert'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import './review.css'

function Section({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className="review-section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function ComponentReview(): React.JSX.Element {
  const [dark, setDark] = useState(false)
  const [zh, setZh] = useState(true)
  const [narrow, setNarrow] = useState(false)
  const [saved, setSaved] = useState(false)
  const [value, setValue] = useState('')
  const [enabled, setEnabled] = useState(true)
  const text = (cn: string, en: string): string => (zh ? cn : en)
  return (
    <div
      className={dark ? 'dark review-root' : 'review-root'}
      lang={zh ? 'zh-CN' : 'en'}
      style={
        {
          ...getThemePresetDefinition('connected').cssVars[dark ? 'dark' : 'light'],
          width: narrow ? 390 : '100%',
          maxWidth: '100%'
        } as CSSProperties
      }
    >
      <header className="review-header">
        <OlaBrand />
        <div className="review-controls">
          <Button variant="outline" aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>
            {text(narrow ? '完整宽度' : '390px 容器', narrow ? 'Full width' : '390px container')}
          </Button>
          <Button variant="outline" onClick={() => setZh(!zh)}>
            {zh ? 'English' : '中文'}
          </Button>
          <Button variant="outline" onClick={() => setDark(!dark)}>
            {text(dark ? '切换浅色' : '切换深色', dark ? 'Light theme' : 'Dark theme')}
          </Button>
        </div>
      </header>
      <main className="review-main">
        <p className="review-kicker">OLA · {text('开发审查', 'DEVELOPER REVIEW')}</p>
        <h1>{text('组件状态与反馈', 'Component states and feedback')}</h1>
        <p className="review-intro">
          {text(
            '使用产品实际组件；所有输入和操作仅在本页内生效，不连接账户或设备。',
            'Uses the actual product components. Inputs and actions stay in this page without connecting accounts or devices.'
          )}
        </p>
        <Section title={text('操作与键盘焦点', 'Actions and keyboard focus')}>
          <div className="review-row">
            <Button onClick={() => setSaved(true)}>{text('保存示例', 'Save example')}</Button>
            <Button variant="outline" onClick={() => setSaved(false)}>
              {text('重置反馈', 'Reset feedback')}
            </Button>
            <Button disabled>{text('暂不可用', 'Unavailable')}</Button>
            <Button disabled aria-busy="true">
              <Spinner aria-label={text('正在保存', 'Saving')} />
              {text('正在保存', 'Saving')}
            </Button>
            <Button variant="destructive" onClick={() => setSaved(false)}>
              {text('清除本页反馈', 'Clear local feedback')}
            </Button>
          </div>
          <p className="review-feedback" role="status">
            {saved
              ? text(
                  '示例已保存；没有提交到服务端。',
                  'Example saved locally; nothing was submitted.'
                )
              : text(
                  '使用 Tab 检查每个可操作控件的焦点。',
                  'Use Tab to check focus on every interactive control.'
                )}
          </p>
        </Section>
        <Section title={text('表单与校验', 'Forms and validation')}>
          <div className="review-grid">
            <label className="review-field">
              {text('工作区名称', 'Workspace name')}
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={text('输入示例名称', 'Enter an example name')}
              />
            </label>
            <label className="review-field">
              {text('字段错误', 'Invalid field')}
              <Input
                aria-invalid="true"
                aria-describedby="review-field-error"
                defaultValue="invalid-address"
              />
              <span id="review-field-error" className="review-error">
                {text('请输入有效的邮箱地址。', 'Enter a valid email address.')}
              </span>
            </label>
            <label className="review-field">
              {text('只读资料', 'Read-only information')}
              <Input readOnly value={text('团队工作区 · 示例', 'Team workspace · example')} />
            </label>
            <label className="review-field">
              {text('禁用字段', 'Disabled field')}
              <Input
                disabled
                placeholder={text('等待授权后可用', 'Available after authorization')}
              />
            </label>
          </div>
          <label className="review-switch">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={text('示例同步开关', 'Example sync switch')}
            />
            {text('示例同步开关', 'Example sync switch')}
          </label>
        </Section>
        <Section title={text('资源状态', 'Resource states')}>
          <div className="review-grid">
            <div className="review-state">
              <h3>{text('加载中', 'Loading')}</h3>
              <div className="review-row" role="status">
                <Spinner aria-label={text('正在加载', 'Loading')} />
                {text('正在获取工作区资源…', 'Loading workspace resources…')}
              </div>
              <Skeleton className="mt-3 h-4 w-3/4" />
              <Skeleton className="mt-2 h-4 w-1/2" />
            </div>
            <div className="review-state">
              <h3>{text('成功获取空目录', 'Successfully loaded an empty directory')}</h3>
              <p>
                {text('当前工作区尚未配置模型。', 'No models are configured in this workspace.')}
              </p>
              <Badge variant="outline">{text('没有资源', 'No resources')}</Badge>
            </div>
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{text('同步失败', 'Sync failed')}</AlertTitle>
              <AlertDescription>
                {text(
                  '暂时无法连接服务。保留上次配置，联网后可以重试。',
                  'The service could not be reached. Keep the previous configuration and retry when connected.'
                )}
              </AlertDescription>
            </Alert>
            <Alert>
              <LockKeyhole />
              <AlertTitle>{text('没有访问权限', 'Access unavailable')}</AlertTitle>
              <AlertDescription>
                {text(
                  '请切换到有权限的账户或工作区。',
                  'Choose an account or workspace with access.'
                )}
              </AlertDescription>
            </Alert>
          </div>
          <div className="review-row mt-4">
            <Badge>
              <Check />
              {text('已同步 · 示例', 'Synced · example')}
            </Badge>
            <Badge variant="secondary">{text('在线状态未知', 'Presence unknown')}</Badge>
            <Badge variant="outline">{text('本机自定义模型', 'Local custom model')}</Badge>
            <Badge variant="destructive">{text('授权已失效', 'Authorization expired')}</Badge>
          </div>
        </Section>
        <Section title={text('长内容与局部滚动', 'Long content and local scrolling')}>
          <p className="review-long">
            {text('团队模型来源：', 'Team model source: ')}
            Ola-workspace-with-a-very-long-name-and-resource-identifier-012345678901234567890123456789
          </p>
          <div
            className="review-scroll"
            tabIndex={0}
            aria-label={text('可滚动的示例目录', 'Scrollable example directory')}
          >
            {Array.from({ length: 12 }, (_, index) => (
              <div className="review-list-row" key={index}>
                <span>
                  {text('默认插件示例', 'Default plugin example')} {index + 1}
                </span>
                <Badge variant="outline">{text('示例', 'Example')}</Badge>
              </div>
            ))}
          </div>
          <p className="review-feedback">
            {text(
              '应能滚动到第 12 项；底部操作始终在目录之外。',
              'Item 12 must remain reachable. The action stays outside the scroll container.'
            )}
          </p>
          <Button variant="outline" onClick={() => setSaved(false)}>
            {text('返回示例操作', 'Example return action')}
          </Button>
        </Section>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<ComponentReview />)
