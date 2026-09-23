import { useCallback, useEffect, useState } from "react";

export type SearchEngine = "google" | "bing";

const STORAGE_KEY = "shufang:search-engine";
const CHANGE_EVENT = "shufang:search-engine-change";

export function searchUrl(engine: SearchEngine, text: string): string {
  const query = encodeURIComponent(text);
  return engine === "bing"
    ? `https://www.bing.com/search?q=${query}`
    : `https://www.google.com/search?q=${query}`;
}

function loadSearchEngine(): SearchEngine {
  if (typeof window === "undefined") return "google";
  return localStorage.getItem(STORAGE_KEY) === "bing" ? "bing" : "google";
}

export function useSearchEngine(): [
  SearchEngine,
  (engine: SearchEngine) => void,
] {
  const [engine, setEngine] = useState(loadSearchEngine);
  useEffect(() => {
    const sync = () => setEngine(loadSearchEngine());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const save = useCallback((next: SearchEngine) => {
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    setEngine(next);
  }, []);
  return [engine, save];
}
