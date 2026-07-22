import * as React from 'react'
import type { ReasoningEffortLevel } from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'

interface ReasoningEffortSliderProps {
  levels: ReasoningEffortLevel[]
  value: ReasoningEffortLevel
  disabled?: boolean
  getDescription?: (level: ReasoningEffortLevel) => string
  onChange: (level: ReasoningEffortLevel) => void
}

export function ReasoningEffortSlider({
  levels,
  value,
  disabled,
  getDescription,
  onChange
}: ReasoningEffortSliderProps): React.JSX.Element | null {
  const selectedIndex = Math.max(0, levels.indexOf(value))
  if (levels.length === 0) return null

  return (
    <div className={cn('space-y-1.5', disabled && 'opacity-60')}>
      <input
        type="range"
        min={0}
        max={Math.max(0, levels.length - 1)}
        step={1}
        value={selectedIndex}
        disabled={disabled}
        aria-label="Reasoning effort"
        aria-valuetext={levels[selectedIndex]}
        className="h-1.5 w-full cursor-pointer accent-violet-500 disabled:cursor-not-allowed"
        onChange={(event) => onChange(levels[Number(event.currentTarget.value)])}
      />
      <div className="flex justify-between gap-1">
        {levels.map((level, index) => (
          <button
            key={level}
            type="button"
            disabled={disabled}
            title={getDescription?.(level)}
            className={cn(
              'min-w-0 text-[9px] uppercase transition-colors',
              index === selectedIndex
                ? 'font-semibold text-foreground'
                : 'text-muted-foreground/65 hover:text-foreground'
            )}
            onClick={() => onChange(level)}
          >
            {level}
          </button>
        ))}
      </div>
    </div>
  )
}
