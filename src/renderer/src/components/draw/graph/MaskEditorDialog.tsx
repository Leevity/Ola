import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import type { MaskStroke } from '@renderer/lib/draw-image-operations'
import type { DrawGraphAssetRef } from '../../../../../shared/draw-graph'

export function MaskEditorDialog({
  open,
  asset,
  strokes,
  brushSize,
  onOpenChange,
  onStrokesChange,
  onBrushSizeChange,
  onSave
}: {
  open: boolean
  asset: DrawGraphAssetRef | null
  strokes: MaskStroke[]
  brushSize: number
  onOpenChange: (open: boolean) => void
  onStrokesChange: (strokes: MaskStroke[]) => void
  onBrushSizeChange: (size: number) => void
  onSave: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.strokeStyle = 'rgba(239, 68, 68, 0.75)'
    context.fillStyle = 'rgba(239, 68, 68, 0.75)'
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (const stroke of strokes) {
      if (!stroke.points.length) continue
      context.lineWidth = stroke.size
      context.beginPath()
      context.moveTo(stroke.points[0].x, stroke.points[0].y)
      for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y)
      if (stroke.points.length === 1) {
        context.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2)
        context.fill()
      } else context.stroke()
    }
  }, [strokes])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('drawPage.graph.mask', { defaultValue: 'Mask editor' })}</DialogTitle>
        </DialogHeader>
        {asset ? (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {t('drawPage.graph.maskHint', {
                defaultValue: 'Paint the area that the next image edit should regenerate.'
              })}
            </div>
            <input
              type="range"
              min="4"
              max={Math.max(8, Math.round(Math.min(asset.width, asset.height) * 0.25))}
              value={brushSize}
              onChange={(event) => onBrushSizeChange(Number(event.target.value))}
            />
            <canvas
              ref={canvasRef}
              className="max-h-[60vh] w-full cursor-crosshair rounded border bg-contain bg-center bg-no-repeat"
              width={asset.width}
              height={asset.height}
              style={{
                aspectRatio: `${asset.width}/${asset.height}`,
                backgroundImage: `url(ola-draw-asset://${asset.id})`
              }}
              onPointerDown={(event) => {
                const canvas = event.currentTarget
                canvas.setPointerCapture(event.pointerId)
                const bounds = canvas.getBoundingClientRect()
                onStrokesChange([
                  ...strokes,
                  {
                    size: brushSize,
                    points: [
                      {
                        x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
                        y: ((event.clientY - bounds.top) / bounds.height) * canvas.height
                      }
                    ]
                  }
                ])
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                const canvas = event.currentTarget
                const bounds = canvas.getBoundingClientRect()
                const point = {
                  x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
                  y: ((event.clientY - bounds.top) / bounds.height) * canvas.height
                }
                onStrokesChange(
                  strokes.map((stroke, index) =>
                    index === strokes.length - 1
                      ? { ...stroke, points: [...stroke.points, point] }
                      : stroke
                  )
                )
              }}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onStrokesChange([])}>
            {t('drawPage.graph.clear', { defaultValue: 'Clear' })}
          </Button>
          <Button disabled={strokes.length === 0} onClick={onSave}>
            {t('drawPage.graph.saveMask', { defaultValue: 'Save mask' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
