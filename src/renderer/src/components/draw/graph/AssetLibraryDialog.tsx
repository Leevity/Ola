import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import type { DrawGraphAssetRef } from '../../../../../shared/draw-graph'

export type AssetLibraryItem = DrawGraphAssetRef & { url: string }

export function AssetLibraryDialog({
  open,
  assets,
  onOpenChange,
  onSelect
}: {
  open: boolean
  assets: AssetLibraryItem[]
  onOpenChange: (open: boolean) => void
  onSelect: (asset: AssetLibraryItem) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('drawPage.graph.assetLibrary')}</DialogTitle>
        </DialogHeader>
        {assets.length > 0 ? (
          <div className="grid max-h-[60vh] grid-cols-3 gap-3 overflow-auto sm:grid-cols-4">
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                className="rounded-lg border p-2 text-left hover:border-primary"
                onClick={() => onSelect(asset)}
              >
                <img
                  className="aspect-square w-full rounded object-contain bg-black/5"
                  src={asset.url}
                  alt=""
                />
                <div className="mt-1 truncate text-[10px] text-muted-foreground">
                  {asset.width} × {asset.height}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('drawPage.graph.noAssets', { defaultValue: 'No saved assets yet.' })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
