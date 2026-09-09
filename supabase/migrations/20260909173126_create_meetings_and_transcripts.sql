-- 1. Create meetings table
CREATE TABLE IF NOT EXISTS public.meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT,
    meet_url TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Create transcript_entries table
CREATE TABLE IF NOT EXISTS public.transcript_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_meeting_sequence UNIQUE (meeting_id, sequence)
);

-- 3. Create indexes for querying performance
CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON public.meetings(user_id);
CREATE INDEX IF NOT EXISTS idx_transcript_entries_meeting_id ON public.transcript_entries(meeting_id);
CREATE INDEX IF NOT EXISTS idx_transcript_entries_meeting_seq ON public.transcript_entries(meeting_id, sequence);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcript_entries ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies for meetings
CREATE POLICY "Users can view their own meetings"
    ON public.meetings
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own meetings"
    ON public.meetings
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own meetings"
    ON public.meetings
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own meetings"
    ON public.meetings
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- 6. RLS Policies for transcript_entries
CREATE POLICY "Users can view transcripts of their own meetings"
    ON public.transcript_entries
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.meetings
            WHERE public.meetings.id = transcript_entries.meeting_id
            AND public.meetings.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert transcripts for their own meetings"
    ON public.transcript_entries
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.meetings
            WHERE public.meetings.id = transcript_entries.meeting_id
            AND public.meetings.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update transcripts of their own meetings"
    ON public.transcript_entries
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.meetings
            WHERE public.meetings.id = transcript_entries.meeting_id
            AND public.meetings.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.meetings
            WHERE public.meetings.id = transcript_entries.meeting_id
            AND public.meetings.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete transcripts of their own meetings"
    ON public.transcript_entries
    FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.meetings
            WHERE public.meetings.id = transcript_entries.meeting_id
            AND public.meetings.user_id = auth.uid()
        )
    );

-- 7. Grant schema and table permissions to authenticated role
GRANT ALL ON TABLE public.meetings TO authenticated;
GRANT ALL ON TABLE public.transcript_entries TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
