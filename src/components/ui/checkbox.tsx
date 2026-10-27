import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

/**
 * 复选框。
 *
 * 实现要点（勿轻易改动）：
 * 原生 input 以透明层覆盖在视觉方块之上，点击命中 input 自身，`onChange` 是唯一的
 * 状态上报入口；视觉层只做展示、不挂 onClick。
 *
 * 历史坑：旧实现把 onClick 挂在视觉层 div 上，而调用方普遍用 `<label>` 包裹整个条目。
 * 此时一次点击会走两条路径——div 的 onClick 上报一次，label 的隐式激活行为再把 click
 * 转发给 input 触发 onChange 上报一次，两次取反相互抵消。React 在离散事件结束时同步
 * flush 更新，使第二次上报读到的是翻转后的 checked，勾选会被立刻弹回，
 * 用户侧表现为「点了没反应 / 反应很慢 / 要连点好几次」。
 */
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked = false, onCheckedChange, disabled, id, ...props }, ref) => {
    return (
      <div className="relative inline-flex items-center">
        <input
          type="checkbox"
          id={id}
          className="peer absolute inset-0 z-10 h-4.5 w-4.5 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          ref={ref}
          checked={checked}
          onChange={e => onCheckedChange?.(e.target.checked)}
          disabled={disabled}
          {...props}
        />
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-border/80 bg-background text-primary-foreground shadow-2xs transition-all',
            'peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
            // 视觉层不接收指针事件，hover / disabled 态一律由覆盖其上的 input（peer）驱动
            checked ? 'bg-primary border-primary text-primary-foreground' : 'peer-hover:border-primary/60',
            'peer-disabled:opacity-50',
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
