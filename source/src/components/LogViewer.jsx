import React, { useMemo, useState } from 'react';
import { Terminal, Loader2, CheckCircle2, AlertCircle, Info, X, SkipForward, Copy, Square } from 'lucide-react';
import { formatFileSize } from '../utils/formatFileSize';

/** スキップ系は進捗・完了タブに混ぜない（スキップタブ専用） */
const isSkipped = (log) => {
  const msg = log.message || '';
  return msg.includes('スキップ') || msg.includes('既存のフォルダを使用') || msg.includes('既存のルートフォルダ');
};

const hasCompletionMessage = (msg) => /転送完了|変換完了|作成完了|移行完了|失敗|既存のフォルダ/.test(msg || '');

const isInProgress = (log) => {
  if (log.type === 'error') return false;
  if (isSkipped(log)) return false;
  const p = log.progress;
  const msg = log.message || '';
  if (p !== null && p !== undefined && p < 100) return true;
  if (p >= 100 && !hasCompletionMessage(msg)) return true;
  return false;
};

const isCompleted = (log) => {
  if (log.type === 'error') return false;
  if (isSkipped(log)) return false;
  const p = log.progress;
  const msg = log.message || '';
  return ((p !== null && p !== undefined && p >= 100) || log.type === 'success') && hasCompletionMessage(msg);
};

const isError = (log) => log.type === 'error';

/** フォルダ移行の全体進捗行（上部バー専用。タブ一覧には出さない） */
const isOverallMigrationProgressLine = (log) => {
  if (!log.id?.startsWith('migrate-')) return false;
  const m = log.message || '';
  return (
    m.includes('移行進捗') ||
    m.includes('移行開始') ||
    m.includes('移行完了')
  );
};

/** DL/UL 二本は「どちらかがまだ途上」のときだけ。両方100%や完了行は同じ数字が二重に見えるので単一バーにする */
const shouldShowDualTransferBars = (log) => {
  if (!log.id?.startsWith('file-')) return false;
  if (typeof log.progress_download !== 'number' || typeof log.progress_upload !== 'number') return false;
  if (log.type === 'success' || log.type === 'error') return false;
  if (isSkipped(log)) return false;
  const msg = log.message || '';
  if (hasCompletionMessage(msg)) return false;
  const dl = log.progress_download;
  const ul = log.progress_upload;
  if (dl >= 100 && ul >= 100) return false;
  return true;
};

export const LogViewer = ({
  logs = [],
  onClear,
  onClose,
  onStopMigration,
  isMigrating = false,
  isMigrationStopping = false
}) => {
  const [activeTab, setActiveTab] = useState('progress');

  const { progressLogs, completedLogs, errorLogs, skippedLogs } = useMemo(() => ({
    progressLogs: logs.filter((l) => isInProgress(l) && !isOverallMigrationProgressLine(l)),
    completedLogs: logs.filter((l) => isCompleted(l) && !isOverallMigrationProgressLine(l)),
    errorLogs: logs.filter(isError),
    skippedLogs: logs.filter(isSkipped)
  }), [logs]);

  const overallProgressLog = useMemo(() => {
    const matches = logs.filter(isOverallMigrationProgressLine);
    if (matches.length === 0) return null;
    // 常に「直近の migrate 全体行」。過去の「移行完了」だけを拾うと、新しい実行の進捗に追従しない（スキップ多めの短い実行で顕著）
    return matches[matches.length - 1];
  }, [logs]);

  const displayLogs = useMemo(() => {
    if (activeTab === 'progress') return progressLogs;
    if (activeTab === 'completed') return completedLogs;
    if (activeTab === 'error') return errorLogs;
    return skippedLogs;
  }, [activeTab, progressLogs, completedLogs, errorLogs, skippedLogs]);

  if (logs.length === 0) return null;

  /** 報告用: セッション内のエラー行だけまとめてコピー（タブに関係なく全件） */
  const copyErrorLogsForReport = () => {
    if (errorLogs.length === 0) return;
      const lines = errorLogs.map((log) => {
        const t = log.time || '--:--:--';
        const idPart = log.id ? ` id=${log.id}` : '';
        const m = log.message || '';
        const d = log.detail ? ` | ${log.detail}` : '';
        return `[${t}]${idPart} ${m}${d}`;
      });
    const text = lines.join('\n');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  };

  const progressCount = progressLogs.length;
  const tabs = [
    { id: 'progress', label: '進捗', count: progressCount, icon: Loader2 },
    { id: 'completed', label: '完了', count: completedLogs.length, icon: CheckCircle2 },
    { id: 'skipped', label: 'スキップ', count: skippedLogs.length, icon: SkipForward },
    { id: 'error', label: 'エラー', count: errorLogs.length, icon: AlertCircle }
  ];

  return (
    <div className="flex flex-col w-full animate-in slide-in-from-bottom duration-300">
      <div className="px-4 py-2 min-h-[44px] bg-slate-800/95 border-t border-slate-700 shrink-0 flex flex-col gap-1.5 justify-center">
        <span className={`text-[11px] font-medium ${overallProgressLog ? 'text-slate-300' : 'text-slate-500'}`}>
          {overallProgressLog ? (overallProgressLog.message || '処理中...') : '---'}
        </span>
        {overallProgressLog?.progress != null && (
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-slate-700/60 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full rounded-full ${overallProgressLog.progress >= 100 ? 'bg-emerald-500' : 'bg-sky-400'}`}
                style={{ width: `${overallProgressLog.progress}%` }}
              />
            </div>
            <span className="text-[10px] font-bold tabular-nums min-w-[32px] text-right text-sky-400">
              {Math.round(overallProgressLog.progress)}%
            </span>
          </div>
        )}
      </div>
      <div className="border-t border-slate-200 bg-slate-900 text-slate-300 flex flex-col h-48 w-full">
      <div className="h-8 px-4 flex items-center justify-between bg-slate-800 border-b border-slate-700 shrink-0 select-none">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-indigo-400" />
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Migration Console</span>
          <div className="flex items-center gap-1">
            {tabs.map(({ id, label, count, icon: TabIcon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`px-2 py-1 rounded text-[9px] font-bold uppercase tracking-tighter flex items-center gap-1 transition-colors ${
                  activeTab === id
                    ? 'bg-slate-600 text-white'
                    : 'bg-slate-700/60 text-slate-400 hover:text-slate-300'
                }`}
              >
                <TabIcon size={10} className={id === 'progress' && count > 0 ? 'animate-spin' : ''} />
                {label}
                <span className="px-1 py-0.5 rounded bg-slate-700 text-[8px] min-w-[16px] text-center">{count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isMigrating && (
            <button
              type="button"
              onClick={onStopMigration}
              disabled={isMigrationStopping}
              className="flex items-center gap-1 text-[9px] font-bold text-amber-300 hover:text-amber-200 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              title="移行停止（進行中のみ完了後に停止）"
            >
              {isMigrationStopping ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
              {isMigrationStopping ? '停止要求中...' : '移行停止'}
            </button>
          )}
          <button
            type="button"
            disabled={errorLogs.length === 0}
            onClick={copyErrorLogsForReport}
            title="エラーログをすべてクリップボードへ（問い合わせ・報告用）"
            className="flex items-center gap-1 text-[9px] font-bold text-rose-400/90 hover:text-rose-300 disabled:opacity-35 disabled:hover:text-rose-400/90 disabled:cursor-not-allowed transition-colors"
          >
            <Copy size={12} />
            エラーをコピー
          </button>
          <button
            onClick={onClear}
            className="text-[9px] font-bold text-slate-500 hover:text-slate-300 transition-colors uppercase tracking-tighter"
          >
            Clear
          </button>
          <button
            onClick={onClose}
            className="p-1 text-slate-500 hover:text-slate-300 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="migration-console-log flex-1 overflow-auto p-3 font-mono text-[11px] space-y-1 custom-scrollbar cursor-text">
        {displayLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-[10px]">
            {activeTab === 'progress' && '実行中のタスクはありません'}
            {activeTab === 'completed' && '完了したタスクはありません'}
            {activeTab === 'skipped' && 'スキップされた項目はありません'}
            {activeTab === 'error' && 'エラーはありません'}
          </div>
        ) : (
          displayLogs.map((log, idx) => {
            const skipped = isSkipped(log);
            const Icon = log.type === 'success' ? CheckCircle2 :
                         log.type === 'error' ? AlertCircle : skipped ? SkipForward : Info;
            const iconColor = log.type === 'success' ? 'text-emerald-400' :
                              log.type === 'error' ? 'text-rose-400' : skipped ? 'text-amber-400' : 'text-indigo-400';

            return (
              <div key={log.id || idx} className="flex gap-3 py-0.5 border-b border-slate-800/50 last:border-0 group">
                <span className="text-slate-600 shrink-0 min-w-[52px]">[{log.time || '--:--:--'}]</span>
                <div className={`mt-0.5 ${iconColor} shrink-0`}>
                  <Icon size={12} />
                </div>
                <div className="flex-1 flex flex-col min-w-0">
                  <span
                    className={`break-all ${
                      log.type === 'error'
                        ? 'text-rose-300'
                        : log.type === 'success'
                          ? 'text-emerald-300'
                          : skipped
                            ? 'text-amber-300'
                            : 'text-slate-300'
                    }`}
                  >
                    {log.message || '処理中...'}
                  </span>
                  {log.detail ? (
                    <span className="text-[9px] text-slate-500 break-all leading-snug mt-0.5 border-l border-slate-600/80 pl-1.5">
                      {log.detail}
                    </span>
                  ) : null}
                  {log.progress !== null && log.progress !== undefined && (
                    <div className="mt-1 flex flex-col gap-1">
                      {shouldShowDualTransferBars(log) ? (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="text-[8px] font-bold text-slate-500 w-6 shrink-0">DL</span>
                            <div className="flex-1 bg-slate-700/60 rounded-full h-[2px] overflow-hidden">
                              <div
                                className={`h-full rounded-full ${log.progress_download >= 100 ? 'bg-cyan-500/90' : 'bg-cyan-400/80'}`}
                                style={{ width: `${log.progress_download}%` }}
                              />
                            </div>
                            <span className="text-[8px] font-bold tabular-nums min-w-[26px] text-right text-cyan-400/90">
                              {Math.round(log.progress_download)}%
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[8px] font-bold text-slate-500 w-6 shrink-0">UL</span>
                            <div className="flex-1 bg-slate-700/60 rounded-full h-[2px] overflow-hidden">
                              <div
                                className={`h-full rounded-full ${log.progress_upload >= 100 ? 'bg-violet-500/90' : 'bg-violet-400/80'}`}
                                style={{ width: `${log.progress_upload}%` }}
                              />
                            </div>
                            <span className="text-[8px] font-bold tabular-nums min-w-[26px] text-right text-violet-400/90">
                              {Math.round(log.progress_upload)}%
                            </span>
                          </div>
                          {typeof log.bytes_total === 'number' && log.bytes_total > 0 && (
                            <div className="text-[8px] text-slate-500 tabular-nums pl-8">
                              DL {formatFileSize(log.bytes_downloaded ?? 0)} / {formatFileSize(log.bytes_total)} · UL{' '}
                              {formatFileSize(log.bytes_uploaded ?? 0)} / {formatFileSize(log.bytes_total)}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-slate-700/60 rounded-full h-[2px] overflow-hidden">
                              <div
                                className={`h-full rounded-full ${log.progress >= 100 ? 'bg-emerald-500' : 'bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.6)]'}`}
                                style={{ width: `${log.progress}%` }}
                              />
                            </div>
                            <span className={`text-[9px] font-bold tabular-nums min-w-[28px] text-right ${log.progress >= 100 ? 'text-emerald-500' : 'text-sky-400'}`}>
                              {Math.round(log.progress)}%
                            </span>
                          </div>
                          {typeof log.bytes_total === 'number' && log.bytes_total > 0 && (
                            <div className="text-[8px] text-slate-500 tabular-nums">
                              {formatFileSize(Math.round((log.bytes_total * log.progress) / 100))} / {formatFileSize(log.bytes_total)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      </div>
    </div>
  );
};
