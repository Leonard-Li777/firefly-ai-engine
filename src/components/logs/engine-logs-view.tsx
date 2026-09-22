import React, { useRef, useEffect, useState, useCallback } from 'react'
import {
  Terminal,
  Trash2,
  Copy,
  Check,
  RefreshCw,
  ChevronsDown,
  Search,
  X,
  WrapText,
  AlignLeft,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'

/**
 * 将单行启动命令格式化为清晰的多行可读形式（按 flag 换行，对超长参数如 --chat-template 进行自然换行，支持 \ 续行符）
 */
function formatLaunchCommandMultiLine(rawCmd: string): string {
  if (!rawCmd) return ''

  // 1. 提取可执行文件路径与后续参数
  const match = rawCmd.match(/^("[^"]+"|\S+)\s*(.*)$/)
  if (!match) return rawCmd

  const bin = match[1]
  const rest = match[2]
  if (!rest) return bin

  // 2. 状态机解析参数，保留引号内部的完整内容
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let quoteChar = ''

  for (let i = 0; i < rest.length; i++) {
    const char = rest[i]
    if ((char === '"' || char === "'") && (i === 0 || rest[i - 1] !== '\\')) {
      if (!inQuotes) {
        inQuotes = true
        quoteChar = char
      } else if (char === quoteChar) {
        inQuotes = false
        quoteChar = ''
      }
      current += char
    } else if (/\s/.test(char) && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current.length > 0) {
    tokens.push(current)
  }

  // 3. 按照参数标志 (以 - 或 -- 开头) 重新聚合为多行
  const lines: string[] = [bin]
  let currentFlag = ''
  let currentVal = ''

  const flushArg = () => {
    if (!currentFlag) return
    // 若当前参数是 --chat-template，将 flag 与内部 Jinja 语句按逻辑标签自然拆行排版
    if (currentFlag === '--chat-template' && currentVal) {
      lines.push(`  ${currentFlag} \\`)

      // 去除最外层包裹的双引号或单引号进行深入拆行
      let inner = currentVal.trim()
      let wrapperQuote = ''
      if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
        wrapperQuote = inner[0]
        inner = inner.slice(1, -1)
      }

      // 按照 Jinja 标签边界 ({% ... %} 或 {{ ... }}) 进行自然切行
      const jinjaSegments: string[] = []
      // 匹配 {% ... %} 或 {{ ... }} 或中间文本
      const regex = /({%.*?%}|{{.*?}}|[^{]+)/g
      let m: RegExpExecArray | null
      while ((m = regex.exec(inner)) !== null) {
        const seg = m[0].trim()
        if (seg) jinjaSegments.push(seg)
      }

      if (jinjaSegments.length > 1) {
        for (let sIdx = 0; sIdx < jinjaSegments.length; sIdx++) {
          const isFirst = sIdx === 0
          const isLast = sIdx === jinjaSegments.length - 1
          const segText = jinjaSegments[sIdx]
          const prefix = isFirst && wrapperQuote ? wrapperQuote : ''
          const suffix = isLast && wrapperQuote ? wrapperQuote : ''
          lines.push(`    ${prefix}${segText}${suffix} \\`)
        }
      } else {
        // 如果无法拆分标签，则按 75 字符限制自然软折行
        const chunkSize = 75
        for (let c = 0; c < currentVal.length; c += chunkSize) {
          const slice = currentVal.slice(c, c + chunkSize)
          lines.push(`    ${slice} \\`)
        }
      }
    } else {
      const full = currentVal ? `${currentFlag} ${currentVal}` : currentFlag
      lines.push(`  ${full} \\`)
    }
    currentFlag = ''
    currentVal = ''
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith('-')) {
      flushArg()
      currentFlag = token
    } else {
      if (currentVal) {
        currentVal += ` ${token}`
      } else {
        currentVal = token
      }
    }
  }
  flushArg()

  // 清除最后一行的末尾续行符 \
  if (lines.length > 1) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s+\\$/, '')
  }

  return lines.join('\n')
}

/** 解析日志行，着色 [cmd] / [stdout] / [stderr] 与关键词 */
function colorize(line: string): { prefix: string; prefixClass: string; rest: string; restClass: string } {
  if (line.startsWith('[cmd]')) {
    const rest = line.slice(5)
    return {
      prefix: '[cmd]',
      prefixClass: 'text-amber-300 font-black tracking-wide',
      rest,
      restClass: 'text-emerald-300 font-bold font-mono'
    }
  }
  if (line.startsWith('[stdout]')) {
    const rest = line.slice(8)
    // 高亮关键信号词
    const restClass = rest.includes('listening') || rest.includes('ready')
      ? 'text-emerald-400'
      : rest.includes('error') || rest.includes('Error')
        ? 'text-red-400'
        : rest.includes('warning') || rest.includes('Warning')
          ? 'text-amber-400'
          : 'text-slate-300'
    return { prefix: '[stdout]', prefixClass: 'text-sky-400 font-bold', rest, restClass }
  }
  if (line.startsWith('[stderr]')) {
    const rest = line.slice(8)
    const restClass = rest.includes('error') || rest.includes('Error') || rest.includes('GGML')
      ? 'text-red-400'
      : rest.includes('warning')
        ? 'text-amber-400'
        : 'text-slate-400'
    return { prefix: '[stderr]', prefixClass: 'text-rose-400 font-bold', rest, restClass }
  }
  return { prefix: '', prefixClass: '', rest: line, restClass: 'text-slate-400' }
}

export const EngineLogsView: React.FC = () => {
  const { t } = useI18nStore()
  const { logs, logsLoading, fetchLogs, clearLogs } = useEngineStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const [copiedCmdIdx, setCopiedCmdIdx] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  /** 启动命令换行展开模式：默认 false (单行紧凑 + 超长省略截断)；true = 展开完整排版多行 */
  const [cmdMultiLine, setCmdMultiLine] = useState<boolean>(false)
  /** 记录单条卡片用户显式点击展开/折叠状态 */
  const [expandedCmds, setExpandedCmds] = useState<Record<number, boolean>>({})

  // 定时轮询日志（每 2s 刷新）
  useEffect(() => {
    fetchLogs()
    const interval = setInterval(() => {
      useEngineStore.getState().fetchLogs()
    }, 2000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 自动吸底滚动
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  // 监听用户手动滚动：若向上滚动则关闭自动滚动
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 32
    setAutoScroll(isAtBottom)
  }, [])

  const handleCopyAll = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(logs.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }
  }

  const handleClear = async () => {
    await clearLogs()
  }

  const handleScrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    setAutoScroll(true)
  }

  // 过滤日志
  const filteredLogs = searchQuery.trim()
    ? logs.filter(line => line.toLowerCase().includes(searchQuery.toLowerCase()))
    : logs

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full h-full gap-3">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-800/80 border border-slate-700/60 text-sky-400">
            <Terminal className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-base font-black tracking-tight text-foreground leading-none">
              {t('运行日志')}
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              llama-server · stdout / stderr
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] font-bold font-mono border-slate-600/60 text-slate-400 bg-slate-800/40">
            {filteredLogs.length} {t('条')}
          </Badge>
          {logsLoading && (
            <RefreshCw className="h-3.5 w-3.5 text-sky-400 animate-spin" />
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* 搜索 */}
          {showSearch ? (
            <div className="flex items-center gap-1.5 bg-slate-800/80 border border-slate-600/60 rounded-xl px-3 h-9">
              <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                className="bg-transparent text-xs text-foreground outline-none w-36 sm:w-48 placeholder:text-slate-500"
                placeholder={t('搜索日志...')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                autoFocus
              />
              <button
                className="text-slate-400 hover:text-foreground"
                onClick={() => { setShowSearch(false); setSearchQuery('') }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-9 px-3 text-xs font-bold border-slate-700/60 bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 gap-1.5"
              onClick={() => setShowSearch(true)}
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden sm:block">{t('搜索')}</span>
            </Button>
          )}

          {/* 启动命令展开/折叠模式切换 */}
          <Button
            size="sm"
            variant="outline"
            className={`h-9 px-3 text-xs font-bold border-slate-700/60 gap-1.5 transition-colors ${
              cmdMultiLine
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
                : 'bg-slate-800/60 hover:bg-slate-700/60 text-slate-300'
            }`}
            onClick={() => {
              setCmdMultiLine(prev => !prev)
              // 重置所有独立卡片的覆盖状态，遵循全局切换
              setExpandedCmds({})
            }}
            title={cmdMultiLine ? t('当前：默认展开多行排版') : t('当前：默认单行省略')}
          >
            {cmdMultiLine ? (
              <WrapText className="h-3.5 w-3.5 text-amber-300" />
            ) : (
              <AlignLeft className="h-3.5 w-3.5 text-slate-400" />
            )}
            <span className="hidden sm:block">
              {cmdMultiLine ? t('多行展开') : t('单行折叠')}
            </span>
          </Button>

          {/* 复制全量日志 */}
          <Button
            size="sm"
            variant="outline"
            className="h-9 px-3 text-xs font-bold border-slate-700/60 bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 gap-1.5"
            onClick={handleCopyAll}
            disabled={logs.length === 0}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="hidden sm:block">{t('已复制')}</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span className="hidden sm:block">{t('复制全量')}</span>
              </>
            )}
          </Button>

          {/* 清空日志 */}
          <Button
            size="sm"
            variant="outline"
            className="h-9 px-3 text-xs font-bold border-rose-700/50 bg-rose-900/20 hover:bg-rose-800/30 text-rose-400 gap-1.5"
            onClick={handleClear}
            disabled={logs.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden sm:block">{t('清空日志')}</span>
          </Button>
        </div>
      </div>

      {/* 自动滚动开关提示 */}
      {!autoScroll && (
        <button
          className="flex items-center gap-2 text-xs text-sky-400 hover:text-sky-300 self-end transition-colors shrink-0"
          onClick={handleScrollToBottom}
        >
          <ChevronsDown className="h-4 w-4 animate-bounce" />
          <span>{t('跳至最新日志')}</span>
        </button>
      )}

      {/* 终端日志面板：严格限制在容器内部垂直/水平滚动 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 w-full rounded-2xl bg-[#0d1117] border border-slate-700/50 overflow-auto p-4 font-mono text-xs leading-relaxed shadow-inner select-text"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-3 text-muted-foreground py-16">
            <Terminal className="h-12 w-12 opacity-20" />
            <p className="text-sm font-semibold opacity-50">
              {searchQuery ? t('无匹配日志') : t('暂无日志，等待服务启动...')}
            </p>
          </div>
        ) : (
          <div className="w-full min-w-0 space-y-1 pb-2">
            {filteredLogs.map((line, idx) => {
              const isCmd = line.startsWith('[cmd]')
              if (isCmd) {
                const rawCmd = line.slice(5).trim()
                // 判断当前卡片是否换行：若用户在该卡片上显式切换过则使用局部状态，否则遵循全局设置
                const isLineMulti = expandedCmds[idx] !== undefined ? expandedCmds[idx] : cmdMultiLine
                const formattedCmd = isLineMulti ? formatLaunchCommandMultiLine(rawCmd) : rawCmd

                return (
                  <div
                    key={idx}
                    className="my-2.5 p-3 rounded-xl bg-slate-900/95 border border-amber-500/35 shadow-md flex flex-col gap-2 transition-all max-w-full"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 font-black text-[10px] tracking-wider border border-amber-500/30 flex items-center gap-1">
                          <Terminal className="h-3 w-3 text-amber-400" />
                          {t('启动命令 (Launch Command)')}
                        </span>
                        <span className="text-slate-500 text-[10px] font-mono hidden sm:inline">llama-server CLI</span>
                        <Badge
                          variant="outline"
                          className="text-[9px] font-mono border-slate-700 text-slate-400 px-1.5 h-4.5 cursor-pointer hover:border-amber-500/50 hover:text-amber-300 transition-colors"
                          onClick={() => setExpandedCmds(prev => ({ ...prev, [idx]: !isLineMulti }))}
                          title={t('点击切换换行状态')}
                        >
                          {isLineMulti ? t('分行排版') : t('单行紧凑')}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {/* 局部换行切换 */}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px] text-slate-400 hover:text-slate-200 hover:bg-slate-800 font-mono gap-1"
                          onClick={() => setExpandedCmds(prev => ({ ...prev, [idx]: !isLineMulti }))}
                          title={isLineMulti ? t('切换为单行紧凑格式') : t('切换为多行按参数格式')}
                        >
                          {isLineMulti ? (
                            <>
                              <AlignLeft className="h-3 w-3 text-slate-400" />
                              <span className="hidden sm:inline">{t('单行')}</span>
                            </>
                          ) : (
                            <>
                              <WrapText className="h-3 w-3 text-amber-300" />
                              <span className="hidden sm:inline">{t('换行')}</span>
                            </>
                          )}
                        </Button>

                        {/* 复制按钮 */}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px] text-slate-300 hover:text-white hover:bg-slate-800 font-mono gap-1 border border-slate-700/60"
                          onClick={() => {
                            if (typeof navigator !== 'undefined' && navigator.clipboard) {
                              navigator.clipboard.writeText(formattedCmd)
                              setCopiedCmdIdx(idx)
                              setTimeout(() => setCopiedCmdIdx(null), 2000)
                            }
                          }}
                        >
                          {copiedCmdIdx === idx ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-400" />
                              <span className="text-emerald-400">{t('已复制')}</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>{t('复制命令')}</span>
                            </>
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* 启动命令行内容：默认单行省略截断，点击自动展开为全量多行 */}
                    <div
                      className={`relative rounded-lg p-1.5 transition-colors cursor-pointer select-all ${
                        !isLineMulti ? 'hover:bg-slate-800/50' : ''
                      }`}
                      onClick={() => setExpandedCmds(prev => ({ ...prev, [idx]: !isLineMulti }))}
                      title={!isLineMulti ? t('点击自动展开完整启动命令') : t('点击折叠为单行')}
                    >
                      {!isLineMulti ? (
                        <div className="flex items-center justify-between gap-2 overflow-hidden">
                          <p className="text-emerald-300 font-bold font-mono text-[11px] truncate flex-1 min-w-0 tracking-tight">
                            {rawCmd}
                          </p>
                          <span className="shrink-0 flex items-center gap-1 text-[10px] text-amber-400/90 font-mono bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 rounded border border-amber-500/30">
                            <span>{t('展开全部')}</span>
                            <ChevronDown className="h-3 w-3" />
                          </span>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <pre className="text-emerald-300 font-bold font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre font-sans-none">
                            <code>{formattedCmd}</code>
                          </pre>
                          <div className="flex justify-end pt-1">
                            <span className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-amber-300 font-mono px-1.5 py-0.5 rounded transition-colors">
                              <span>{t('点击折叠单行')}</span>
                              <ChevronRight className="h-3 w-3 -rotate-90" />
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              }

              const { prefix, prefixClass, rest, restClass } = colorize(line)
              return (
                <div key={idx} className="flex items-start gap-2 group hover:bg-slate-800/30 px-1 py-0.5 rounded transition-colors whitespace-pre">
                  {/* 行号 */}
                  <span className="text-slate-600 select-none shrink-0 w-8 text-right text-[10px] leading-[1.6]">
                    {idx + 1}
                  </span>
                  {/* 日志内容 */}
                  <span className="break-all whitespace-pre-wrap">
                    {prefix && (
                      <span className={`${prefixClass} mr-1`}>{prefix}</span>
                    )}
                    <span className={restClass}>{rest}</span>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1 shrink-0">
        <span className="font-mono">
          {autoScroll ? (
            <span className="flex items-center gap-1.5 text-emerald-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {t('自动滚动已开启')}
            </span>
          ) : (
            <span className="text-slate-500">{t('自动滚动已暂停（向下滚动可恢复）')}</span>
          )}
        </span>
        <span className="font-mono text-slate-600">
          {searchQuery ? `${filteredLogs.length} / ${logs.length} ${t('条')}` : `${logs.length} ${t('条日志')}`}
        </span>
      </div>
    </div>
  )
}
