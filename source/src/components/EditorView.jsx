import React from 'react';
import { X, Globe, FileUp, Loader2, Download, FileCode } from 'lucide-react';

export const EditorView = ({
  currentFileName,
  content,
  setContent,
  setActiveTab,
  currentFilePath,
  saveToGoogleDocs,
  isGDriveProcessing,
  gDriveToken,
  downloadFile
}) => {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Editor Toolbar (ExplorerColumn と同一の 56px) */}
      <div className="h-[56px] px-6 border-b border-slate-200 bg-white flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center text-indigo-500 shrink-0">
            <FileCode size={18} strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Editing File</p>
            <p className="text-xs font-black text-slate-700 truncate">{currentFileName || 'エディタ'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setActiveTab('scan')}
            className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-all"
            title="リストに戻る"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="h-[48px] px-6 border-b border-slate-100 flex items-center justify-end bg-slate-50/20 gap-3 shrink-0">
        {currentFilePath && (
          <a
            href={`https://www.dropbox.com/preview${currentFilePath}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-[10px] font-black hover:bg-slate-50 transition-all flex items-center gap-2 shadow-sm"
          >
            <Globe size={12} className="text-indigo-500" /> Web で確認
          </a>
        )}
        {gDriveToken && (
          <button
            onClick={() => saveToGoogleDocs(content, currentFileName)}
            disabled={!content || isGDriveProcessing}
            className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-[10px] font-black hover:bg-emerald-700 transition-all flex items-center gap-2 disabled:opacity-50 shadow-lg shadow-emerald-100"
          >
            {isGDriveProcessing ? <Loader2 className="animate-spin" size={12} /> : <FileUp size={12} strokeWidth={2.5} />}
            Google ドキュメントで保存
          </button>
        )}
        <button onClick={() => downloadFile('docx', content, currentFileName)} disabled={!content} className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-[10px] font-black hover:bg-indigo-700 transition-all flex items-center gap-2 disabled:opacity-50 shadow-lg shadow-indigo-100">
          <Download size={12} strokeWidth={2.5} /> Word 形式
        </button>
        <button onClick={() => downloadFile('md', content, currentFileName)} disabled={!content} className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-[10px] font-black hover:bg-slate-50 transition-all disabled:opacity-50 shadow-sm">
          Markdown
        </button>
      </div>

      {/* Textarea */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="flex-1 w-full p-4 focus:outline-none resize-none text-xs leading-relaxed font-mono text-slate-600 border-none bg-white"
        placeholder="Paperから読み込まれた内容がここに表示されます。"
      />
    </div>
  );
};
