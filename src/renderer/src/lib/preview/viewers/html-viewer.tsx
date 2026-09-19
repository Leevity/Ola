import { CodeEditor } from '@renderer/components/editor/CodeEditor'
import type { ViewerProps } from '../viewer-registry'

export function HtmlViewer({
  filePath,
  content,
  viewMode,
  onContentChange,
  onSave,
  initialLine,
  initialColumn,
  initialPositionKey
}: ViewerProps): React.JSX.Element {
  if (viewMode === 'preview') {
    return (
      <iframe
        className="size-full border-0 bg-white"
        // A preview is data, never application code.  An empty sandbox blocks
        // scripts, same-origin access, navigation, forms, and downloads.
        sandbox=""
        srcDoc={content}
        title="HTML Preview"
      />
    )
  }

  return (
    <CodeEditor
      filePath={filePath}
      content={content}
      onChange={onContentChange}
      onSave={onSave}
      initialLine={initialLine}
      initialColumn={initialColumn}
      initialPositionKey={initialPositionKey}
    />
  )
}
