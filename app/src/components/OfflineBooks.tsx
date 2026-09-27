import { useEffect, useState } from "react";
import { getAllBooks, getFile, syncDatabase } from "@/lib/db";
import type { Book } from "@/types";

export function OfflineBooks() {
  const [books, setBooks] = useState<Book[]>([]);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const reload = () => {
      void getAllBooks().then(setBooks);
    };
    reload();
    window.addEventListener("shufang:sync-updated", reload);
    return () => window.removeEventListener("shufang:sync-updated", reload);
  }, []);
  async function pin() {
    if (!selected) return;
    setMessage("正在下载并校验原文件…");
    try {
      const file = await getFile(selected);
      if (!file) throw new Error("此书尚未上传原文件");
      const db = await syncDatabase();
      await db.put("syncMeta", { id: `pin:${selected}`, pinned: true });
      if (navigator.storage?.persist) await navigator.storage.persist();
      setMessage(
        "原文件已保存到此浏览器，可离线阅读；浏览器清理站点数据仍会移除缓存。"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下载失败，可重试");
    }
  }
  return (
    <div className="mt-3 border-t pt-2">
      <label className="block">
        固定离线书籍
        <select
          className="my-1 block w-full bg-background"
          value={selected}
          onChange={event => setSelected(event.target.value)}
        >
          <option value="">选择书籍</option>
          {books.map(book => (
            <option key={book.id} value={book.id}>
              {book.title}
            </option>
          ))}
        </select>
      </label>
      <button
        className="underline"
        disabled={!selected}
        onClick={() => void pin()}
      >
        下载并固定离线
      </button>
      {message && (
        <p role="status" className="mt-1">
          {message}
        </p>
      )}
    </div>
  );
}
