import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked = false, onCheckedChange, disabled, id, ...props }, ref) => {
    return (
      <div className="relative inline-flex items-center">
        <input
          type="checkbox"
          id={id}
          className="peer sr-only"
          ref={ref}
          checked={checked}
          onChange={e => onCheckedChange?.(e.target.checked)}
          disabled={disabled}
          {...props}
        />
        <div
          onClick={() => !disabled && onCheckedChange?.(!checked)}
          className={cn(
            'flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-border/80 bg-background text-primary-foreground shadow-2xs transition-all cursor-pointer',
            'peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
            checked ? 'bg-primary border-primary text-primary-foreground' : 'hover:border-primary/60',
            disabled && 'cursor-not-allowed opacity-50',
            className
          )}
        >
          {checked && <Check className="h-3 w-3 stroke-[2.5]" />}
        </div>
      </div>
    )
  }
)
Checkbox.displayName = 'Checkbox'

export { Checkbox }
