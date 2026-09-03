import { useEffect, useState } from 'react';
import { FileText, Layers, ScanText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export type PdfMode = 'reflow' | 'original';

/**
 * PDF 导入前的逐文件模式选择：
 * - 重排文本：提取文字重新排版，可调整字号，适合纯文字 PDF
 * - 原版版面：保留 PDF 原始排版逐页阅读，适合扫描件 / 图文混排
 */
export function ImportModeDialog({
  files,
  onConfirm,
  onCancel,
}: {
  files: File[] | null;
  onConfirm: (modes: Map<File, PdfMode>) => void;
  onCancel: () => void;
}) {
  const [modes, setModes] = useState<Record<number, PdfMode>>({});

  useEffect(() => {
    setModes({});
  }, [files]);

  if (!files || files.length === 0) return null;

  const modeOf = (i: number): PdfMode => modes[i] ?? 'reflow';
  const setAll = (m: PdfMode) => {
    const next: Record<number, PdfMode> = {};
    files.forEach((_, i) => (next[i] = m));
    setModes(next);
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>PDF 排版方式</DialogTitle>
          <DialogDescription>
            为每个文件选择阅读方式，导入后仍可随时在书籍菜单中切换。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>全部设为：</span>
          <button className="rounded-full border border-border px-2 py-0.5 hover:bg-accent" onClick={() => setAll('reflow')}>
            重排文本
          </button>
          <button className="rounded-full border border-border px-2 py-0.5 hover:bg-accent" onClick={() => setAll('original')}>
            原版版面
          </button>
        </div>

        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {files.map((f, i) => {
            const m = modeOf(i);
            return (
              <div key={`${f.name}-${i}`} className="rounded-lg border border-border p-2.5">
                <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium">
                  <FileText size={13} className="shrink-0 text-primary/70" />
                  <span className="truncate" title={f.name}>{f.name}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => setModes((s) => ({ ...s, [i]: 'reflow' }))}
                    className={`flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[11.5px] transition-colors ${
                      m === 'reflow'
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <ScanText size={12} /> 重排文本
                  </button>
                  <button
                    onClick={() => setModes((s) => ({ ...s, [i]: 'original' }))}
                    className={`flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[11.5px] transition-colors ${
                      m === 'original'
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <Layers size={12} /> 原版版面
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          重排文本可调整字号、参与全文检索；原版版面完整保留 PDF 排版，适合扫描件与图文混排。两种方式都会保存原始文件，可随时切换。
        </p>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button
            size="sm"
            onClick={() => {
              const map = new Map<File, PdfMode>();
              files.forEach((f, i) => map.set(f, modeOf(i)));
              onConfirm(map);
            }}
          >
            开始导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 拆分待导入文件：PDF 需要选择排版方式，其余直接导入 */
export function splitImportFiles(files: File[]): { pdfs: File[]; others: File[] } {
  const pdfs: File[] = [];
  const others: File[] = [];
  for (const f of files) {
    (f.name.toLowerCase().endsWith('.pdf') ? pdfs : others).push(f);
  }
  return { pdfs, others };
}
