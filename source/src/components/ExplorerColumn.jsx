import React, { useRef, useEffect, useLayoutEffect } from 'react';
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
  /** フォルダ移動時は変わるキー（同じキー内での一覧更新＝リネーム時はスクロールを維持） */
  scrollContextKey,
  children
}) => {
  const breadcrumbRef = useRef(null);
  const listScrollRef = useRef(null);
  /** 一覧差し替え前に DOM がリセットされることがあるため、onScroll で常に保持する */
  const lastListScrollTopRef = useRef(0);
  const prevScrollContextKeyRef = useRef(scrollContextKey);
  /** 一覧更新直後、ブラウザが一瞬 scrollTop=0 にして onScroll が先に走ると ref が 0 に汚れるのを防ぐ */
  const suppressScrollCaptureRef = useRef(false);
  const scrollRestoreGenRef = useRef(0);

  // オートスクロール: パンくずリストが追加されたら右端へ
  useEffect(() => {
    if (breadcrumbRef.current) {
      breadcrumbRef.current.scrollTo({
        left: breadcrumbRef.current.scrollWidth,
        behavior: 'smooth'
      });
    }
  }, [breadcrumbs]);

  useLayoutEffect(() => {
    if (scrollContextKey === undefined) return;
    const el = listScrollRef.current;
    if (scrollContextKey !== prevScrollContextKeyRef.current) {
      prevScrollContextKeyRef.current = scrollContextKey;
      lastListScrollTopRef.current = 0;
      if (el) el.scrollTop = 0;
      return;
    }
    if (!el) return;
    const target = lastListScrollTopRef.current;
    const ctx = scrollContextKey;
    scrollRestoreGenRef.current += 1;
    const gen = scrollRestoreGenRef.current;
    suppressScrollCaptureRef.current = true;
    el.scrollTop = target;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (gen !== scrollRestoreGenRef.current) return;
        const inner = listScrollRef.current;
        if (inner && prevScrollContextKeyRef.current === ctx) {
          inner.scrollTop = target;
        }
        suppressScrollCaptureRef.current = false;
      });
    });
  }, [items, scrollContextKey]);

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
        <div
          ref={listScrollRef}
          onScroll={(e) => {
            if (suppressScrollCaptureRef.current) return;
            lastListScrollTopRef.current = e.currentTarget.scrollTop;
          }}
          className="absolute inset-0 overflow-auto p-3 space-y-1 custom-scrollbar"
        >
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
