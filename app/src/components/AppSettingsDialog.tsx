import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSearchEngine } from "@/lib/searchEngine";

/** Local, application-wide preferences that are independent of an account. */
export function AppSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [searchEngine, setSearchEngine] = useSearchEngine();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-[22px] bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <Search size={18} className="text-primary" /> 应用设置
          </DialogTitle>
        </DialogHeader>
        <section>
          <h3 className="text-[13px] font-medium">搜索引擎</h3>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            阅读时划选文字后，“搜索”会使用此引擎打开查询。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(["google", "bing"] as const).map(engine => (
              <button
                key={engine}
                type="button"
                onClick={() => setSearchEngine(engine)}
                className={`rounded-[12px] border px-3 py-2 text-[12px] transition-colors ${
                  searchEngine === engine
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-secondary"
                }`}
              >
                {engine === "google" ? "Google" : "Bing"}
              </button>
            ))}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
