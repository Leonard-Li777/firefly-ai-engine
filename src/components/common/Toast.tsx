import React from 'react'
import { create } from 'zustand'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastItemData {
  id: string
  message: string
  type: ToastType
  duration?: number
}

interface ToastStore {
  toasts: ToastItemData[]
  addToast: (toast: Omit<ToastItemData, 'id'> & { id?: string }) => string
  removeToast: (id: string) => void
}

export const useToastStore = create<ToastStore>(set => ({
  toasts: [],
  addToast: toastData => {
    const id = toastData.id || Math.random().toString(36).substring(7)
    set(state => {
      const existing = state.toasts.findIndex(t => t.id === id)
      if (existing >= 0) {
        const copy = [...state.toasts]
        copy[existing] = { ...toastData, id }
        return { toasts: copy }
      }
      return { toasts: [...state.toasts, { ...toastData, id }] }
    })

    const duration = toastData.duration === undefined ? 4000 : toastData.duration
    if (duration > 0) {
      setTimeout(() => {
        set(state => ({
          toasts: state.toasts.filter(t => t.id !== id)
        }))
      }, duration)
    }

    return id
  },
  removeToast: id =>
    set(state => ({
      toasts: state.toasts.filter(t => t.id !== id)
    }))
}))

export const toast = {
  success: (message: string, duration?: number, id?: string) =>
    useToastStore.getState().addToast({ message, type: 'success', duration, id }),
  error: (message: string, duration?: number, id?: string) =>
    useToastStore.getState().addToast({ message, type: 'error', duration, id }),
  warning: (message: string, duration?: number, id?: string) =>
    useToastStore.getState().addToast({ message, type: 'warning', duration, id }),
  info: (message: string, duration?: number, id?: string) =>
    useToastStore.getState().addToast({ message, type: 'info', duration, id }),
  dismiss: (id: string) => useToastStore.getState().removeToast(id)
}

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[99999] flex flex-col gap-2.5 max-w-sm pointer-events-none">
      {toasts.map(item => {
        const isError = item.type === 'error'
        const isSuccess = item.type === 'success'
        const isWarning = item.type === 'warning'

        return (
          <div
            key={item.id}
            className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-xl border shadow-lg backdrop-blur-md transition-all animate-in slide-in-from-top-2 duration-200 ${
              isError
                ? 'bg-destructive/15 border-destructive/40 text-destructive dark:bg-destructive/20'
                : isSuccess
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 dark:bg-emerald-950/40'
                  : isWarning
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-800 dark:text-amber-400 dark:bg-amber-950/40'
                    : 'bg-card border-border text-foreground'
            }`}
          >
            <div className="shrink-0 mt-0.5">
              {isError && <AlertCircle className="h-4 w-4" />}
              {isSuccess && <CheckCircle2 className="h-4 w-4" />}
              {isWarning && <AlertTriangle className="h-4 w-4" />}
              {!isError && !isSuccess && !isWarning && <Info className="h-4 w-4" />}
            </div>
            <div className="flex-1 min-w-0 text-xs font-semibold leading-relaxed break-words">
              {item.message}
            </div>
            <button
              onClick={() => removeToast(item.id)}
              className="shrink-0 p-0.5 hover:opacity-70 transition-opacity ml-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
