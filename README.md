# 🎙️ Meet Transcript Saver

**Meet Transcript Saver** is a lightweight, privacy-focused Chrome Extension (Manifest V3) that automatically captures live closed captions (CC) from Google Meet sessions, stores them locally in IndexedDB, and batch-synchronizes the transcripts to Supabase PostgreSQL in real-time.

---

## ✨ Features

- ⚡ **Real-time Caption Extraction**: High-performance DOM observer built on structural heuristics—resilient to Google Meet UI class name changes and minification.
- 🧹 **Clean Transcription**: Automatically filters out UI noise, control icons (`arrow_downward`, `Jump to bottom`), and debounces live speech streams.
- 🗄️ **Local-First Storage (IndexedDB)**: Transcripts are saved locally first to guarantee zero data loss during network hiccups.
- 🔄 **Direct Supabase Sync**: Batch uploads entries (20 items/batch or every 3 seconds) with exponential backoff retry.
- 🔒 **Row-Level Security (RLS)**: Enforces per-user data isolation—users can only read and write their own meeting transcripts.
- 🔑 **Google OAuth via Supabase**: Seamless one-click authentication using `chrome.identity.launchWebAuthFlow`.

---

## 🏗️ Architecture

```mermaid
flowchart LR
    A[Google Meet Live CC DOM] --> B[Caption Observer & Parser]
    B --> C[(Local IndexedDB)]
    C --> D[Sync Service Engine]
    D -->|Direct Client Upsert| E[(Supabase PostgreSQL)]
    E --> F[Row Level Security]
```

---

## 📁 Project Structure

```
meet-transcript-saver/
├── entrypoints/
│   ├── background.ts         # Service worker & lifecycle management
│   ├── content.ts            # Content script injected into meet.google.com
│   └── popup/                # Extension Popup UI (React)
├── lib/
│   ├── auth/                 # Google OAuth via chrome.identity & Supabase
│   ├── storage/              # IndexedDB local storage layer
│   ├── supabase/             # Supabase singleton client with chrome.storage adapter
│   ├── sync/                 # Sync engine with batching & backoff retry
│   └── transcript/           # Structural DOM parser & selector heuristics
├── supabase/
│   └── migrations/           # PostgreSQL schema, indexes, RLS policies
├── types/                    # Database & environment TypeScript definitions
├── docs/                     # Detailed setup and requirements documentation
├── wxt.config.ts             # WXT framework configuration & MV3 manifest
└── tsconfig.json             # TypeScript configuration
```

---

## 🚀 Getting Started

### 1. Prerequisites

- **Node.js** >= 18.x
- **pnpm** >= 9.x
- **Supabase CLI** (optional, for migrations)

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-username/meet-transcript-saver.git
cd meet-transcript-saver
pnpm install
```

### 3. Environment Setup

Create a `.env.local` file in the root directory:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-anon-key
```

### 4. Database Setup

Run the SQL migration located in `supabase/migrations/20260909173126_create_meetings_and_transcripts.sql` in your Supabase SQL Editor, or run:

```bash
supabase db push
```

Grant table access to the `authenticated` role:

```sql
GRANT ALL ON TABLE public.meetings TO authenticated;
GRANT ALL ON TABLE public.transcript_entries TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
```

### 5. Google OAuth Configuration

1. In **Google Cloud Console**, create an OAuth 2.0 Web Client.
2. In **Supabase Dashboard → Authentication → URL Configuration**, add your extension redirect URI:
   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```
3. Enable Google Provider in **Supabase Dashboard → Authentication → Providers**.

---

## 🛠️ Development & Build

### Development Mode
```bash
pnpm dev
```

### Production Build
```bash
pnpm build
```
The output will be built into `.output/chrome-mv3`.

### Load into Chrome
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `.output/chrome-mv3` folder.

---

## 📖 Usage

1. Click the **Meet Transcript Saver** extension icon in Chrome and click **Sign in with Google**.
2. Join any Google Meet at [meet.google.com](https://meet.google.com).
3. Turn on **Closed Captions (CC)** on Google Meet.
4. Open the extension popup and click **▶ Start Recording**.
5. When the meeting ends or when you click **⏹ Stop Recording**, all remaining captions will be flushed and synced to Supabase.

---

## 📄 License

MIT License © 2026
