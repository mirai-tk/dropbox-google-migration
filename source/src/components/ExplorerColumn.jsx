import React, { useRef, useEffect } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

export const ExplorerColumn = ({
  title,
  icon: Icon,
  headerBg = 'bg-slate-50',
  iconBg = 'bg-indigo-600',
  actions,
  breadcrumbs = [],
  onBreadcrumbClick,
  infoBar,
  isLoading,
  loadingText = '読み込み中...',
  emptyText = 'フォルダは空です',
  emptyIcon: EmptyIcon,
  items = [],
  renderItem,
  children
}) => {
  const breadcrumbRef = useRef(null);

  // オートスクロール: パンくずリストが追加されたら右端へ
  useEffect(() => {
    if (breadcrumbRef.current) {
      breadcrumbRef.current.scrollTo({
        left: breadcrumbRef.current.scrollWidth,
        behavior: 'smooth'
      });
    }
  }, [breadcrumbs]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white">
      {/* Header (以前のプレミアムな高さを維持) */}
      <div className={`h-[56px] px-6 border-b border-slate-200 ${headerBg} flex items-center justify-between shrink-0`}>
        <div className="flex items-center gap-3">
          <div className={`${iconBg} p-2 rounded-xl text-white shadow-lg shadow-indigo-100/50`}>
            {Icon && <Icon size={16} strokeWidth={2.5} />}
          </div>
          <span className="text-[11px] font-black text-slate-800 uppercase tracking-[0.15em]">{title}</span>
        </div>
        {actions}
      </div>

      {/* Breadcrumbs (以前の仕様に合わせ、よりコンパクトに) */}
      <div
        ref={breadcrumbRef}
        className="h-[48px] px-6 border-b border-slate-100 flex items-center gap-1 overflow-x-auto whitespace-nowrap scrollbar-hide shrink-0 bg-white shadow-inner"
      >
        {breadcrumbs.map((crumb, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && <ChevronRight size={12} className="text-slate-300" />}
            <button
              onClick={() => onBreadcrumbClick && onBreadcrumbClick(idx)}
              className={`text-[10px] font-extrabold px-3 py-1.5 rounded-lg transition-all ${idx === breadcrumbs.length - 1 ? 'text-indigo-600 bg-indigo-50 shadow-sm ring-1 ring-indigo-100/50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
            >
              {crumb.icon ? <crumb.icon size={13} strokeWidth={2.5} /> : crumb.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Info Bar */}
      {infoBar && (
        <div className="h-10 px-6 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
          {infoBar}
        </div>
      )}

      {/* List Content Container (相対配置の親) */}
      <div className="flex-1 relative min-h-0">
        {/* Scrollable List Content */}
        <div className="absolute inset-0 overflow-auto p-3 space-y-1 custom-scrollbar">
          {children}

          {isLoading && items.length === 0 ? (
            <div className="h-60 flex flex-col items-center justify-center text-slate-300 gap-4">
              <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center">
                <Loader2 className="animate-spin text-indigo-500" size={32} />
              </div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em]">{loadingText}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="h-60 flex flex-col items-center justify-center text-slate-100 gap-6">
              <div className="p-8 bg-slate-50 rounded-full">
                 {EmptyIcon && <EmptyIcon size={64} strokeWidth={1} />}
              </div>
              <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.2em]">{emptyText}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {items.map((item, idx) => renderItem(item, idx))}
            </div>
          )}
        </div>

        {/* 既にアイテムがある状態でのローディングオーバーレイ (スクロール領域の外側に配置して固定) */}
        {isLoading && items.length > 0 && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center text-indigo-500 gap-3">
             <div className="w-10 h-10 bg-white shadow-xl shadow-indigo-100 rounded-full flex items-center justify-center">
               <Loader2 className="animate-spin text-indigo-600" size={24} />
             </div>
             <p className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-600">{loadingText}</p>
          </div>
        )}
      </div>
    </div>
  );
};
