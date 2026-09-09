import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Meet Transcript Saver",
    description: "Save Google Meet live CC transcript",
    permissions: ["storage", "identity", "alarms"],
    host_permissions: ["https://meet.google.com/*", "https://*.supabase.co/*"],
  },
});
