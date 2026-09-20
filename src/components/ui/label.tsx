import * as React from 'react'
import { cn } from '../../lib/utils'

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-xs font-black leading-none text-foreground tracking-tight select-none', className)}
      {...props}
    />
  )
)
Label.displayName = 'Label'

export { Label }
