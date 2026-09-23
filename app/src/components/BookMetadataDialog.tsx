import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Book } from "@/types";
import {
  bookMetadataDraft,
  normalizeBookMetadataDraft,
  type BookMetadataDraft,
  type EditableBookMetadata,
} from "@/lib/bookMetadata";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={wide ? "md:col-span-2" : undefined}>
      <span className="mb-1.5 block text-xs font-medium">{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}

const inputClass =
  "w-full rounded-[10px] border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary";

export function BookMetadataDialog({
  book,
  open,
  onOpenChange,
  onSave,
}: {
  book: Book;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (metadata: EditableBookMetadata) => Promise<void>;
}) {
  const [draft, setDraft] = useState<BookMetadataDraft>(() =>
    bookMetadataDraft(book)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(bookMetadataDraft(book));
    setError("");
  }, [book, open]);

  const field = (key: keyof BookMetadataDraft) => ({
    value: draft[key],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => setDraft(current => ({ ...current, [key]: event.target.value })),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    let normalized: EditableBookMetadata;
    try {
      normalized = normalizeBookMetadataDraft(draft);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "元数据格式无效");
      return;
    }
    setSaving(true);
    try {
      await onSave(normalized);
      onOpenChange(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "元数据未能完整保存，请稍后重试"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={value => !saving && onOpenChange(value)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-[22px] bg-card">
        <DialogHeader>
          <DialogTitle className="text-[17px]">编辑书籍元数据</DialogTitle>
          <DialogDescription>
            修改书房与 MySQL 镜像中的目录信息；不会改写原始电子书文件。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          <section>
            <h3 className="font-meta mb-3 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              基本信息
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="书名 *">
                <input
                  autoFocus
                  maxLength={255}
                  className={inputClass}
                  {...field("title")}
                />
              </Field>
              <Field label="副标题">
                <input
                  maxLength={255}
                  className={inputClass}
                  {...field("subtitle")}
                />
              </Field>
              <Field
                label="作者"
                hint="多位作者请用分号分隔；不会把旧数据中的逗号擅自拆开。"
                wide
              >
                <input
                  maxLength={4096}
                  className={inputClass}
                  {...field("authors")}
                />
              </Field>
              <Field label="编者">
                <input
                  maxLength={4096}
                  className={inputClass}
                  {...field("editors")}
                />
              </Field>
              <Field label="译者">
                <input
                  maxLength={4096}
                  className={inputClass}
                  {...field("translators")}
                />
              </Field>
              <Field label="插画者">
                <input
                  maxLength={4096}
                  className={inputClass}
                  {...field("illustrators")}
                />
              </Field>
              <Field label="其他贡献者">
                <input
                  maxLength={4096}
                  className={inputClass}
                  {...field("otherContributors")}
                />
              </Field>
            </div>
          </section>

          <section className="border-t border-border pt-5">
            <h3 className="font-meta mb-3 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              出版信息
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="出版社">
                <input
                  maxLength={255}
                  className={inputClass}
                  {...field("publisher")}
                />
              </Field>
              <Field
                label="出版日期"
                hint="保留原始精度，可填 2026、2026-09 或 2026-09-04。"
              >
                <input
                  inputMode="numeric"
                  placeholder="YYYY / YYYY-MM / YYYY-MM-DD"
                  className={inputClass}
                  {...field("publishedDate")}
                />
              </Field>
              <Field
                label="语言"
                hint="使用 BCP 47 标签，多项用逗号分隔，例如 zh-Hans, en-US。"
              >
                <input className={inputClass} {...field("languages")} />
              </Field>
              <Field label="版次">
                <input
                  maxLength={128}
                  className={inputClass}
                  {...field("edition")}
                />
              </Field>
              <Field label="系列">
                <input
                  maxLength={255}
                  className={inputClass}
                  {...field("series")}
                />
              </Field>
              <Field label="系列序号">
                <input
                  inputMode="decimal"
                  className={inputClass}
                  {...field("seriesIndex")}
                />
              </Field>
            </div>
          </section>

          <section className="border-t border-border pt-5">
            <h3 className="font-meta mb-3 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              标识与分类
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="ISBN">
                <input
                  maxLength={255}
                  className={inputClass}
                  {...field("isbn")}
                />
              </Field>
              <Field label="DOI">
                <input
                  maxLength={255}
                  className={inputClass}
                  {...field("doi")}
                />
              </Field>
              <Field label="ASIN">
                <input
                  maxLength={255}
                  className={inputClass}
                  {...field("asin")}
                />
              </Field>
              <Field label="个人评分（0–5）">
                <input
                  inputMode="decimal"
                  className={inputClass}
                  {...field("rating")}
                />
              </Field>
              <Field
                label="其他标识符"
                hint="每行一项，例如 UUID: 1234-abcd。"
                wide
              >
                <textarea
                  rows={2}
                  className={inputClass}
                  {...field("otherIdentifiers")}
                />
              </Field>
              <Field label="主题 / 标签" hint="多项用逗号分隔。" wide>
                <input className={inputClass} {...field("subjects")} />
              </Field>
            </div>
          </section>

          <section className="grid gap-4 border-t border-border pt-5 md:grid-cols-2">
            <Field label="简介" wide>
              <textarea
                rows={5}
                maxLength={20_000}
                className={inputClass}
                {...field("description")}
              />
            </Field>
            <Field label="版权信息" wide>
              <textarea
                rows={3}
                maxLength={2_000}
                className={inputClass}
                {...field("rights")}
              />
            </Field>
          </section>

          <div className="rounded-[12px] bg-muted/45 px-3 py-2 text-[10.5px] text-muted-foreground">
            只读技术信息：{book.format.toUpperCase()} · {book.chapters.length}{" "}
            章 · 导入于 {new Date(book.createdAt).toLocaleString()}
          </div>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => onOpenChange(false)}
              className="rounded-[10px] px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-[10px] bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? "正在保存…" : "保存元数据"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
