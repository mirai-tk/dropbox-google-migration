import React, { useState, useRef, useEffect } from 'react';
import { Folder, FileType, FileText, Check, ChevronRight, ArrowRight, ExternalLink, Home, HardDrive, FolderPlus, Pencil, X, Loader2, CloudUpload, Copy } from 'lucide-react';
import { formatFileSize } from '../utils/formatFileSize';

export const FileListItem = ({
  item,
  onItemClick,
  isFolder,
  isSelected,
  onToggleSelect,
  showSelect = false,
  showArrow = false,
  onArrowClick,
  showFolderAction = false,
  onFolderActionClick,
  onRecursiveMigrateClick,
  showDuplicateButton = false,
  onDuplicateClick,
  showExternalLink = false,
  externalLink,
  onRename, // async function(newName) returns boolean
  type = 'dropbox' // 'dropbox' or 'gdrive'
}) => {
  const isGDrive = type === 'gdrive';
  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState(item.name);
  const [isRenameSaving, setIsRenameSaving] = useState(false);
  const [isRecursiveMigrating, setIsRecursiveMigrating] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      // Select text without extension if applicable, but since it's a folder mostly, select all
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = async (e) => {
    if (e) {
      e.stopPropagation();
      if (e.type === 'keydown' && e.key !== 'Enter') return;
      if (e.type === 'keydown' && e.nativeEvent.isComposing) return;
    }

    const trimmedName = editName.trim();
    console.log('[FileListItem] handleRenameSubmit triggered for:', item.name, '->', trimmedName);

    if (!trimmedName || trimmedName === item.name) {
      console.log('[FileListItem] No change or empty name, cancelling');
      setIsRenaming(false);
      return;
    }

    setIsRenameSaving(true);
    try {
      console.log('[FileListItem] Calling onRename function...');
      const success = await onRename(trimmedName);
      console.log('[FileListItem] onRename completed with success:', success);

      if (success) {
        setIsRenaming(false);
      } else {
        // Optional: show error state on input
        setEditName(item.name); // revert on fail
        setIsRenaming(false);
      }
    } catch (e) {
      console.error('[FileListItem] Error during rename:', e);
      setEditName(item.name);
      setIsRenaming(false);
    } finally {
      setIsRenameSaving(false);
    }
  };

  const handleRenameCancel = (e) => {
    e.stopPropagation();
    setEditName(item.name);
    setIsRenaming(false);
  };

  const handleRecursiveMigrate = async (e) => {
    e.stopPropagation();
    if (onRecursiveMigrateClick && !isRecursiveMigrating) {
      setIsRecursiveMigrating(true);
      try {
        await onRecursiveMigrateClick();
      } finally {
        setIsRecursiveMigrating(false);
      }
    }
  };

  const handleDuplicate = async (e) => {
    e.stopPropagation();
    if (onDuplicateClick && !isDuplicating) {
      setIsDuplicating(true);
      try {
        await onDuplicateClick();
      } finally {
        setIsDuplicating(false);
      }
    }
  };

  // Dropbox アイコン色 (以前の仕様)
  const dropboxFolderColor = 'bg-amber-50 text-amber-500';
  const dropboxFileColor = 'bg-indigo-50 text-indigo-500';

  // Google Drive アイコン色 (以前の仕様)
  const gDriveFolderColor = item.isRoot ? 'bg-indigo-50 text-indigo-500' :
                           item.isSharedDrive ? 'bg-emerald-50 text-emerald-600' :
                           'bg-emerald-50 text-emerald-500';
  const gDriveFileColor = 'bg-slate-50 text-slate-400';

  const iconBg = isFolder ? (isGDrive ? gDriveFolderColor : dropboxFolderColor) : (isGDrive ? gDriveFileColor : dropboxFileColor);

  // ホバースタイルの調整 (以前の indigo/emerald ベースの洗練された色使いへ)
  const hoverClass = isGDrive
    ? (isFolder ? 'hover:bg-emerald-50/50 hover:border-emerald-100' : 'hover:bg-slate-50')
    : 'hover:bg-indigo-50/30 hover:border-indigo-100/50';

  // ルートフォルダなどは名前変更不可とする
  const canRename = isFolder && onRename && !item.isRoot && !item.isSharedDrive;

  return (
    <div
      className={`flex items-center justify-between p-2 rounded-lg transition-all group border h-[48px] ${isRenaming ? 'bg-slate-50 border-slate-200 shadow-sm' : isSelected ? 'bg-indigo-50/50 border-indigo-100' : `bg-white border-slate-100 ${hoverClass}`} ${!isRenaming && 'cursor-pointer'}`}
      onClick={(e) => {
        if (isRenaming) return;
        isFolder && onItemClick ? onItemClick() : (onToggleSelect && onToggleSelect());
      }}
    >
      <div className="flex items-center gap-2 flex-1 overflow-hidden">
        {showSelect && !isFolder && (
          <div
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
            className={`w-4 h-4 rounded border flex items-center justify-center transition-all cursor-pointer shrink-0 ${isSelected ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-200 hover:border-indigo-300'}`}
          >
            {isSelected && <Check size={10} strokeWidth={3} />}
          </div>
        )}

        <div className="flex items-center gap-2 flex-1 overflow-hidden">
          <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${iconBg}`}>
            {isFolder ? (
              isGDrive ? (
                item.isRoot ? <Home size={14} strokeWidth={2.5} /> :
                item.isSharedDrive ? <HardDrive size={14} strokeWidth={2.5} /> :
                <Folder size={14} strokeWidth={2.5} />
              ) : <Folder size={14} strokeWidth={2.5} />
            ) : (
              isGDrive ? <FileText size={14} /> : <FileType size={14} strokeWidth={2.5} />
            )}
          </div>
          <div className="truncate flex-1 flex items-center h-full">
            {isRenaming ? (
              <div className="flex items-center gap-1 w-full max-w-[200px]" onClick={e => e.stopPropagation()}>
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleRenameSubmit}
                  disabled={isRenameSaving}
                  className="flex-1 text-[11px] font-bold text-slate-700 px-2 py-0.5 border border-indigo-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
                />
                <button
                  onClick={handleRenameSubmit}
                  disabled={isRenameSaving}
                  className="p-1 text-emerald-600 hover:bg-emerald-100 rounded transition-colors disabled:opacity-50"
                  title="保存"
                >
                  {isRenameSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} strokeWidth={3} />}
                </button>
                <button
                  onClick={handleRenameCancel}
                  disabled={isRenameSaving}
                  className="p-1 text-slate-400 hover:bg-slate-200 rounded transition-colors disabled:opacity-50"
                  title="キャンセル"
                >
                  <X size={12} strokeWidth={3} />
                </button>
              </div>
            ) : (
              <div className="flex flex-col min-w-0">
                <p className="text-[11px] font-bold text-slate-700 truncate leading-tight">{item.name}</p>
                <p className="text-[8px] text-slate-400 uppercase tracking-tighter leading-tight mt-0.5">
                  {isGDrive ? (
                    <>
                      {item.isRoot ? 'マイドライブ' : item.isSharedDrive ? '共有ドライブ' : item.mimeType?.split('.').pop() || 'FOLDER'}
                      {item.size ? ` • ${formatFileSize(item.size)}` : ''}
                    </>
                  ) : (
                    <>
                      {isFolder ? 'FOLDER' : (item.name.split('.').pop() || 'FILE')}
                      {item.size ? ` • ${formatFileSize(item.size)}` : ''}
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {canRename && !isRenaming && (
          <button
            onClick={(e) => { e.stopPropagation(); setEditName(item.name); setIsRenaming(true); }}
            className={`opacity-0 group-hover:opacity-100 p-1.5 rounded-md transition-all font-bold ${isGDrive ? 'hover:bg-emerald-100 text-emerald-600' : 'hover:bg-indigo-100 text-indigo-500'}`}
            title="名前を変更"
          >
            <Pencil size={12} strokeWidth={2.5} />
          </button>
        )}
        {isFolder && showDuplicateButton && onDuplicateClick && !isRenaming && (
          <button
            onClick={handleDuplicate}
            disabled={isDuplicating}
            className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-emerald-100 rounded-md text-emerald-600 transition-all font-bold disabled:opacity-50"
            title="フォルダと中身を複製（コピーを作成）"
          >
            {isDuplicating ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} strokeWidth={2.5} />}
          </button>
        )}
        {isFolder && showFolderAction && !isRenaming && (
          <button
            onClick={(e) => { e.stopPropagation(); onFolderActionClick(); }}
            className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-emerald-100 rounded-md text-emerald-600 transition-all font-bold"
            title="現在の保存先（Google Drive）へ同じ名前のフォルダを作成"
          >
            <FolderPlus size={14} />
          </button>
        )}
        {isFolder && onRecursiveMigrateClick && !isRenaming && (
          <button
            onClick={handleRecursiveMigrate}
            disabled={isRecursiveMigrating}
            className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-indigo-100 rounded-md text-indigo-600 transition-all font-bold disabled:opacity-50"
            title="配下のフォルダ・ファイルをすべて再帰的にGoogle Driveへ移行"
          >
            {isRecursiveMigrating ? <Loader2 size={14} className="animate-spin" /> : <CloudUpload size={14} strokeWidth={2.5} />}
          </button>
        )}
        {isFolder && !isRenaming && <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 transition-colors" />}
        {!isFolder && showArrow && (
          <button
            onClick={(e) => { e.stopPropagation(); onArrowClick(); }}
            className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-indigo-100 rounded-md text-indigo-500 transition-all font-bold"
          >
            <ArrowRight size={14} />
          </button>
        )}
        {!isFolder && showExternalLink && externalLink && (
           <a
             href={externalLink}
             target="_blank"
             rel="noopener noreferrer"
             onClick={(e) => e.stopPropagation()}
             className="p-2 text-slate-400 hover:text-emerald-500 rounded-lg hover:bg-emerald-50 transition-all opacity-0 group-hover:opacity-100"
             title="Google ドライブで開く"
           >
             <ExternalLink size={14} strokeWidth={2.5} />
           </a>
        )}
      </div>
    </div>
  );
};
