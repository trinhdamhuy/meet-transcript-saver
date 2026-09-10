import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "Supabase URL or Publishable Anon Key is missing. Please set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local",
  );
}

function isExtensionValid(): boolean {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

const memoryStorage = new Map<string, string>();

// Custom storage adapter using chrome.storage.local to share session between popup and content scripts
const chromeStorageAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    if (!isExtensionValid()) {
      return memoryStorage.get(key) ?? null;
    }
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (result: Record<string, any>) => {
          if (chrome.runtime?.lastError) {
            resolve(memoryStorage.get(key) ?? null);
            return;
          }
          const val = result?.[key];
          resolve(typeof val === "string" ? val : null);
        });
      } catch {
        resolve(memoryStorage.get(key) ?? null);
      }
    });
  },
  setItem: async (key: string, value: string): Promise<void> => {
    memoryStorage.set(key, value);
    if (!isExtensionValid()) return;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => resolve());
      } catch {
        resolve();
      }
    });
  },
  removeItem: async (key: string): Promise<void> => {
    memoryStorage.delete(key);
    if (!isExtensionValid()) return;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove([key], () => resolve());
      } catch {
        resolve();
      }
    });
  },
};

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage:
      typeof chrome !== "undefined" && chrome?.storage?.local
        ? chromeStorageAdapter
        : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
