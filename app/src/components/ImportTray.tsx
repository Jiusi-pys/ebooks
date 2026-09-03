import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import type { Library } from '@/hooks/useLibrary';

/** 右下角导入进度托盘 */
export function ImportTray({ lib }: { lib: Library }) {
  if (lib.imports.length === 0) return null;
  return (
    <div className="fixed bottom-5 right-5 z-50 w-80 space-y-2">
      {lib.imports.map((t) => (
        <div key={t.id} className="rounded-md border border-border bg-card p-3 shadow-lg">
          <div className="flex items-start gap-2.5">
            {t.status === 'working' ? (
              <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-primary" />
            ) : t.status === 'done' ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[#4f7a4f]" />
            ) : (
              <XCircle size={16} className="mt-0.5 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{t.name}</div>
              <div className="font-meta mt-0.5 text-[11px] text-muted-foreground">
                {t.status === 'error' ? t.error : t.stage}
                {t.status === 'working' && ` · ${Math.round(t.ratio * 100)}%`}
              </div>
              {t.status === 'working' && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
                  <div className="h-full bg-primary transition-all" style={{ width: `${t.ratio * 100}%` }} />
                </div>
              )}
            </div>
            {t.status !== 'working' && (
              <button onClick={() => lib.dismissImport(t.id)} className="text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
