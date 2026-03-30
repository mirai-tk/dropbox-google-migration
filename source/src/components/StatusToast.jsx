import React from 'react';
import { AlertCircle, Check, Info, X } from 'lucide-react';

export const StatusToast = ({ status, setStatus }) => {
  if (!status || !status.message) return null;

  const bgClass =
    status.type === 'error' ? 'bg-rose-50 border-rose-100 shadow-rose-100/50' :
    status.type === 'success' ? 'bg-emerald-50 border-emerald-100 shadow-emerald-100/50' :
    'bg-indigo-50 border-indigo-100 shadow-indigo-100/50';

  const iconClass =
    status.type === 'error' ? 'text-rose-500' :
    status.type === 'success' ? 'text-emerald-500' :
    'text-indigo-500';

  const Icon = status.type === 'error' ? AlertCircle : (status.type === 'success' ? Check : Info);

  return (
    <div className={`fixed top-8 right-8 z-[200] max-w-sm flex items-start gap-4 p-5 rounded-[2rem] border shadow-2xl animate-in slide-in-from-top-10 fade-in duration-500 ${bgClass}`}>
      <div className={`p-2.5 rounded-2xl bg-white shadow-sm ${iconClass}`}>
        <Icon size={20} strokeWidth={2.5} />
      </div>
      <div className="flex-1 pt-1">
         <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">{status.type === 'error' ? 'Warning' : 'System Message'}</p>
         <p className="text-xs font-bold text-slate-700 leading-relaxed">{status.message}</p>
      </div>
      <button onClick={() => setStatus(null)} className="p-1.5 hover:bg-white rounded-full text-slate-400 transition-all pt-1">
        <X size={16} />
      </button>
    </div>
  );
};
