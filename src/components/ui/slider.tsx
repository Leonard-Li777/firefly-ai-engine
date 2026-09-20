import { cn } from '../../lib/utils'

export interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  className?: string
  disabled?: boolean
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  className,
  disabled = false
}: SliderProps) {
  const percentage = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))

  return (
    <div className={cn('relative flex w-full touch-none select-none items-center py-1.5', className)}>
      <div className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted/60">
        <div
          className="h-full bg-primary transition-all rounded-full"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
        className="absolute inset-0 h-full w-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
      />
      <div
        className="absolute h-4 w-4 rounded-full border-2 border-primary bg-background shadow-md pointer-events-none transition-transform"
        style={{ left: `calc(${percentage}% - 8px)` }}
      />
    </div>
  )
}
