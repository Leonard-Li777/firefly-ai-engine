import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-bold transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*="size-"])]:size-4 shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer duration-150 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default: 'border border-primary/40 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:border-primary/60',
        destructive: 'border border-destructive/40 bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-border/80 bg-background shadow-xs hover:bg-muted hover:border-border hover:text-foreground',
        secondary: 'border border-border/60 bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 hover:border-border',
        ghost: 'border border-transparent hover:border-border/60 hover:bg-muted hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 rounded-2xl px-6 text-base',
        icon: 'size-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
