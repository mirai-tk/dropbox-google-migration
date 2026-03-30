import React from 'react';
import { FolderOpen, X, ChevronRight, ArrowLeft, FileUp, Loader2, Folder, Check, Building2 } from 'lucide-react';

export const FolderPickerModal = ({
  isOpen,
  onClose,
  gDriveFolders,
  folderSearchTerm,
  selectedFolderId,
  setSelectedFolderId,
  pickerDriveType,
  setPickerDriveType,
  pickerFolderId,
  pickerBreadcrumbs,
  gDriveDrives,
  isGDriveLoading,
  isCreatingFolder,
  setIsCreatingFolder,
  newFolderName,
  setNewFolderName,
  createGDriveFolder,
  navigateToGDriveFolder,
  gDriveToken
}) => {
  if (!isOpen) return null;

  const filteredFolders = gDriveFolders.filter(f =>
    f.name.toLowerCase().includes(folderSearchTerm.toLowerCase())
  );

  const selectedFolderName = selectedFolderId === 'root'
    ? 'マイドライブ'
    : gDriveFolders.find(f => f.id === selectedFolderId)?.name || 'このフォルダ';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-300 flex flex-col max-h-[85vh]">
        <div className="px-8 py-6 border-b border-slate-50 flex items-center justify-between bg-slate-50/30">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-600 p-2.5 rounded-2xl text-white shadow-lg shadow-emerald-100">
              <FolderOpen size={20} />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-800 tracking-tight leading-none mb-1">Google Drive</h3>
              <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest leading-none">Explorer Mode</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-all">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 flex flex-col gap-4 overflow-hidden">
          {/* Drive Type Switcher */}
          <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-100">
             <button
              onClick={() => {
                setPickerDriveType('mydrive');
                navigateToGDriveFolder('root', 'マイドライブ');
              }}
              className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${pickerDriveType === 'mydrive' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
             >
               My Drive
             </button>
             <button
              onClick={() => {
                setPickerDriveType('shared');
                navigateToGDriveFolder('root', '共有ドライブ一覧');
              }}
              className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${pickerDriveType === 'shared' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
             >
               Shared Drives
             </button>
          </div>

          {/* Breadcrumbs & Actions */}
          <div className="flex items-center justify-between border-b border-slate-50 pb-2">
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide flex-1">
              {pickerBreadcrumbs.length > 1 && (
                <button
                  onClick={() => {
                    const parentCrumb = pickerBreadcrumbs[pickerBreadcrumbs.length - 2];
                    navigateToGDriveFolder(parentCrumb.id, parentCrumb.name);
                  }}
                  className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-all shrink-0 mr-1"
                  title="戻る"
                >
                  <ArrowLeft size={16} strokeWidth={2.5} />
                </button>
              )}
              {pickerBreadcrumbs.map((crumb, idx) => (
                <React.Fragment key={crumb.id}>
                  {idx > 0 && <ChevronRight size={12} className="text-slate-300 shrink-0" />}
                  <button
                    onClick={() => navigateToGDriveFolder(crumb.id, crumb.name)}
                    className={`text-[11px] font-bold px-3 py-1.5 rounded-xl transition-all whitespace-nowrap ${idx === pickerBreadcrumbs.length - 1 ? 'text-emerald-600 bg-white shadow-sm ring-1 ring-slate-200/50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {!(pickerDriveType === 'shared' && pickerFolderId === 'root') && (
              <button
                onClick={() => setIsCreatingFolder(true)}
                className="p-2 text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 rounded-xl transition-all shrink-0 ml-2"
                title="新規フォルダ"
              >
                <FileUp size={18} strokeWidth={2.5} />
              </button>
            )}
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar min-h-[300px]">
            {isGDriveLoading ? (
              <div className="h-full flex flex-col items-center justify-center py-20 text-emerald-500 gap-3">
                <Loader2 className="animate-spin" size={32} />
                <p className="text-[10px] font-black uppercase tracking-[0.2em]">Loading Drive...</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {isCreatingFolder && (
                  <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100 flex flex-col gap-3 mb-2 animate-in fade-in slide-in-from-top-2">
                     <div className="flex items-center gap-2">
                       <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center text-white shrink-0">
                         <Folder size={18} strokeWidth={2.5} />
                       </div>
                       <input
                         type="text"
                         value={newFolderName}
                         onChange={(e) => setNewFolderName(e.target.value)}
                         onKeyDown={(e) => {
                           if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                             createGDriveFolder(gDriveToken, pickerFolderId, newFolderName);
                           }
                         }}
                         placeholder="フォルダ名を入力..."
                         autoFocus
                         className="flex-1 bg-white border border-emerald-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 text-slate-700"
                       />
                     </div>
                     <div className="flex gap-2">
                       <button
                         onClick={() => createGDriveFolder(gDriveToken, pickerFolderId, newFolderName)}
                         disabled={!newFolderName.trim() || isGDriveLoading}
                         className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[10px] font-black uppercase py-2.5 rounded-xl transition-all"
                       >
                         {isGDriveLoading ? '作成中...' : '作成する'}
                       </button>
                       <button
                         onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}
                         className="px-4 bg-white hover:bg-slate-50 text-slate-400 hover:text-slate-600 text-[10px] font-black uppercase py-2.5 rounded-xl border border-slate-200 transition-all"
                       >
                         キャンセル
                       </button>
                     </div>
                  </div>
                )}

                {pickerDriveType === 'shared' && pickerFolderId === 'root' ? (
                  <>
                    <div className="flex items-center justify-between px-2 mb-2">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Shared Drives</span>
                    </div>
                    {gDriveDrives.map(drive => (
                      <button
                        key={drive.id}
                        onClick={() => navigateToGDriveFolder(drive.id, drive.name)}
                        className="flex items-center gap-3 p-4 bg-white border border-transparent hover:border-slate-100 hover:bg-slate-50 rounded-2xl transition-all text-left group"
                      >
                        <div className="w-9 h-9 bg-indigo-50 rounded-xl flex items-center justify-center text-indigo-500 shrink-0 group-hover:bg-indigo-500 group-hover:text-white transition-all">
                          <Building2 size={20} strokeWidth={2.5} />
                        </div>
                        <div className="flex-1 truncate">
                          <p className="text-sm font-bold text-slate-700 truncate">{drive.name}</p>
                        </div>
                        <ChevronRight size={16} className="text-slate-300" />
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setSelectedFolderId(pickerFolderId)}
                      className={`flex items-center gap-3 p-4 rounded-2xl transition-all text-left group border border-transparent ${selectedFolderId === pickerFolderId ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-100' : 'bg-emerald-50/50 hover:bg-emerald-50 text-emerald-700 mb-4 border-emerald-100/50'}`}
                    >
                      <Check size={18} className={selectedFolderId === pickerFolderId ? 'text-white' : 'text-emerald-500'} />
                      <div className="flex-1">
                        <p className="text-[10px] font-black uppercase tracking-widest opacity-60 leading-none mb-1">
                          {selectedFolderId === pickerFolderId ? 'Selected' : 'Target'}
                        </p>
                        <p className="text-sm font-black truncate">このフォルダに保存</p>
                      </div>
                    </button>

                    <div className="flex items-center justify-between px-2 mb-2">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subfolders</span>
                    </div>

                    {filteredFolders.map(folder => (
                      <button
                        key={folder.id}
                        onClick={() => navigateToGDriveFolder(folder.id, folder.name)}
                        className="w-full flex items-center gap-3 p-4 bg-white border border-transparent hover:border-slate-100 hover:bg-slate-50 rounded-2xl transition-all text-left overflow-hidden group"
                      >
                        <div className="w-9 h-9 bg-amber-50 rounded-xl flex items-center justify-center text-amber-500 shrink-0 group-hover:bg-amber-500 group-hover:text-white transition-all">
                          <Folder size={20} strokeWidth={2.5} />
                        </div>
                        <div className="flex-1 truncate">
                          <p className="text-sm font-bold text-slate-700 truncate">{folder.name}</p>
                        </div>
                        <ChevronRight size={16} className="text-slate-300" />
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-8 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-6">
          <div className="text-left overflow-hidden">
             <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Selected Destination</p>
             <p className="text-sm font-black text-emerald-600 truncate">{selectedFolderName}</p>
          </div>
          <button
            onClick={onClose}
            className="px-10 py-4 bg-slate-900 text-white rounded-[1.25rem] text-[11px] font-black hover:bg-emerald-600 transition-all uppercase tracking-[0.1em] shadow-xl shadow-slate-200 shrink-0"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
