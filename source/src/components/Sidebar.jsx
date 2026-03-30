import React from 'react';
import { Files, FileCode, Search, ShieldCheck, Globe, LogOut, Info, ChevronRight, Download, RefreshCw, ExternalLink, Activity, Recycle } from 'lucide-react';
import { isDesktopShell } from '../utils/desktopEnv';

export const Sidebar = ({
  activeTab,
  setActiveTab,
  dbToken,
  gDriveToken,
  handleDropboxLogin,
  handleDropboxLogout,
  handleGoogleLogin,
  handleGoogleLogout,
  isGDriveLoading,
  desktopAppVersion,
  desktopUpdateInfo,
  desktopUpdateFetching,
  onDesktopUpdateCheck,
  desktopMemory,
  onDesktopGc,
  desktopGcLoading,
}) => {
  return (
    <aside className="w-64 bg-slate-50 border-r border-slate-200 flex flex-col shrink-0 z-20">
      {/* Brand Header */}
      <div className="p-6 border-b border-slate-100 flex items-center gap-3">
        <div className="w-10 h-10 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-100 transform -rotate-6">
          <Files className="text-white" size={20} />
        </div>
        <div>
          <h1 className="text-sm font-black text-slate-800 tracking-tighter uppercase leading-none mb-0.5">Dropbox to Google Drive Migrator</h1>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Internal Edition</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-8 custom-scrollbar">
        {/* Navigation Section */}
        <div>
          <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-4 mb-4">ナビゲーション</h2>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => setActiveTab('scan')}
              className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl transition-all group ${activeTab === 'scan' ? 'bg-white text-indigo-600 shadow-xl shadow-slate-200/50 ring-1 ring-slate-100' : 'text-slate-500 hover:bg-white hover:text-slate-800'}`}
            >
              <div className={`p-2 rounded-xl transition-all ${activeTab === 'scan' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-slate-100 text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-500'}`}>
                <Search size={18} />
              </div>
              <span className="text-xs font-black tracking-tight">エクスプローラー</span>
            </button>

            <button
              onClick={() => setActiveTab('editor')}
              className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl transition-all group ${activeTab === 'editor' ? 'bg-white text-indigo-600 shadow-xl shadow-slate-200/50 ring-1 ring-slate-100' : 'text-slate-500 hover:bg-white hover:text-slate-800'}`}
            >
              <div className={`p-2 rounded-xl transition-all ${activeTab === 'editor' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-slate-100 text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-500'}`}>
                <FileCode size={18} />
              </div>
              <span className="text-xs font-black tracking-tight">変換エディタ</span>
            </button>
          </div>
        </div>

        {/* Connection Section */}
        <div>
          <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-4 mb-4">接続</h2>
          <div className="flex flex-col gap-4">
            {/* Dropbox */}
            {!dbToken ? (
              <button
                onClick={handleDropboxLogin}
                className="w-full flex items-center justify-between px-5 py-4 bg-indigo-600 text-white rounded-2xl shadow-xl shadow-indigo-100 hover:bg-indigo-700 active:scale-[0.98] transition-all group"
              >
                <div className="flex items-center gap-3">
                  <ShieldCheck size={20} className="group-hover:rotate-12 transition-transform" />
                  <span className="text-xs font-black tracking-tight">Dropbox 連携</span>
                </div>
                <ChevronRight size={14} className="opacity-50" />
              </button>
            ) : (
              <div className="px-5 py-4 bg-white border border-slate-100 rounded-2xl shadow-sm flex items-center justify-between group">
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center text-indigo-600 shrink-0">
                    <ShieldCheck size={16} />
                  </div>
                  <div className="truncate">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Active</p>
                    <p className="text-xs font-black text-slate-700 truncate">Dropbox Connected</p>
                  </div>
                </div>
                <button onClick={handleDropboxLogout} className="p-2 hover:bg-rose-50 hover:text-rose-500 rounded-lg text-slate-300 transition-all ml-1">
                  <LogOut size={16} />
                </button>
              </div>
            )}

            {/* Google Drive */}
            {!gDriveToken ? (
              <button
                onClick={handleGoogleLogin}
                disabled={isGDriveLoading}
                className="w-full flex flex-col gap-3 p-1 bg-white border border-slate-100 shadow-sm rounded-2xl hover:border-emerald-300 transition-all group active:scale-[0.98]"
              >
                <div className="w-full bg-slate-50 flex items-center gap-3 px-4 py-3 rounded-xl">
                  <Globe size={20} className="text-slate-400 group-hover:text-emerald-500 transition-colors" />
                  <div className="text-left">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Google Drive</p>
                    <p className="text-xs font-black text-slate-700">Sign in</p>
                  </div>
                </div>
              </button>
            ) : (
              <div className="px-5 py-4 bg-white border border-slate-100 rounded-2xl shadow-sm flex items-center justify-between group">
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className="w-8 h-8 bg-emerald-50 rounded-lg flex items-center justify-center text-emerald-600 shrink-0">
                    <Globe size={16} />
                  </div>
                  <div className="truncate">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Active</p>
                    <p className="text-xs font-black text-slate-700 truncate">Google Connected</p>
                  </div>
                </div>
                <button onClick={handleGoogleLogout} className="p-2 hover:bg-rose-50 hover:text-rose-500 rounded-lg text-slate-300 transition-all ml-1">
                  <LogOut size={16} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-8 mt-auto border-t border-slate-100 space-y-3">
        {isDesktopShell() && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Info size={12} className="text-slate-400 shrink-0" />
                <p className="text-[10px] font-black text-slate-700 uppercase tracking-widest truncate">
                  v{desktopAppVersion ?? '…'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onDesktopUpdateCheck?.()}
                disabled={desktopUpdateFetching}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-40"
                title="アップデートを確認"
              >
                <RefreshCw size={14} className={desktopUpdateFetching ? 'animate-spin' : ''} />
              </button>
            </div>
            {desktopUpdateInfo?.update_available && desktopUpdateInfo?.download_url && (
              <button
                type="button"
                onClick={() => window.open(desktopUpdateInfo.download_url, '_blank', 'noopener,noreferrer')}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-emerald-500 text-white text-[10px] font-black uppercase tracking-tight shadow-lg shadow-emerald-100 hover:bg-emerald-600 transition-all"
              >
                <Download size={14} />
                新バージョン {desktopUpdateInfo.latest_version}
                <ExternalLink size={12} className="opacity-80" />
              </button>
            )}
            {desktopUpdateInfo?.error && (
              <p className="text-[9px] font-bold text-amber-700 leading-snug px-0.5">
                更新確認: {desktopUpdateInfo.error}
              </p>
            )}
            {desktopUpdateInfo && !desktopUpdateInfo.configured && !desktopUpdateInfo.error && (
              <p className="text-[9px] font-bold text-slate-400 leading-snug px-0.5">
                {desktopUpdateInfo.message || 'アップデート先 URL を .env で設定してください。'}
              </p>
            )}
            <div className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Activity size={12} className="text-violet-500 shrink-0" />
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-tight">メモリ</span>
                </div>
                <button
                  type="button"
                  onClick={() => onDesktopGc?.()}
                  disabled={desktopGcLoading}
                  className="p-1 rounded-md text-slate-400 hover:bg-violet-50 hover:text-violet-600 disabled:opacity-40"
                  title="gc.collect() を実行して RSS を再計測"
                >
                  <Recycle size={12} className={desktopGcLoading ? 'animate-spin' : ''} />
                </button>
              </div>
              <div className="flex justify-between items-baseline gap-2">
                <span className="text-[9px] font-bold text-slate-400">RSS</span>
                <span className="text-[11px] font-mono font-black text-slate-700 tabular-nums">
                  {desktopMemory?.rss_mb != null ? `${desktopMemory.rss_mb} MB` : '—'}
                </span>
              </div>
              <div className="flex justify-between items-baseline gap-2">
                <span className="text-[9px] font-bold text-slate-400">仮想</span>
                <span className="text-[10px] font-mono text-slate-500 tabular-nums">
                  {desktopMemory?.vms_mb != null ? `${desktopMemory.vms_mb} MB` : '—'}
                </span>
              </div>
              {Array.isArray(desktopMemory?.gc_counts) && (
                <p className="text-[8px] font-mono text-slate-400 leading-tight">
                  GC gen: [{desktopMemory.gc_counts.join(', ')}]
                </p>
              )}
              {desktopMemory?.hint && (
                <p className="text-[8px] font-bold text-slate-400 leading-snug" title={desktopMemory.hint}>
                  {desktopMemory.hint.length > 72 ? `${desktopMemory.hint.slice(0, 72)}…` : desktopMemory.hint}
                </p>
              )}
            </div>
          </div>
        )}
        {!isDesktopShell() && (
          <div className="flex items-center gap-2 mb-2">
            <Info size={12} className="text-slate-400" />
            <p className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Version Alpha</p>
          </div>
        )}
        <p className="text-[10px] font-bold text-slate-400 leading-relaxed px-1">Dropbox をシームレスに Google Drive へ。</p>
      </div>
    </aside>
  );
};
