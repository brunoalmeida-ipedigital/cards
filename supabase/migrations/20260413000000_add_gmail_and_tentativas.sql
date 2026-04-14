-- Add tentativas_datas column to atendimentos
ALTER TABLE public.atendimentos ADD COLUMN IF NOT EXISTS tentativas_datas JSONB DEFAULT '{}';

-- Create gmail_emails table
CREATE TABLE IF NOT EXISTS public.gmail_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id TEXT UNIQUE,
  subject TEXT,
  sender TEXT,
  company TEXT,
  is_new BOOLEAN DEFAULT true,
  summary TEXT,
  interactions INT DEFAULT 1,
  last_message_at TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.gmail_emails ENABLE ROW LEVEL SECURITY;

-- Public access policies for gmail_emails
CREATE POLICY "Anyone can read gmail_emails" ON public.gmail_emails FOR SELECT USING (true);
CREATE POLICY "Anyone can insert gmail_emails" ON public.gmail_emails FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update gmail_emails" ON public.gmail_emails FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete gmail_emails" ON public.gmail_emails FOR DELETE USING (true);

-- Auto-update updated_at for gmail_emails
CREATE OR REPLACE FUNCTION public.update_gmail_emails_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_gmail_emails_updated_at
BEFORE UPDATE ON public.gmail_emails
FOR EACH ROW
EXECUTE FUNCTION public.update_gmail_emails_updated_at();

-- Enable realtime for gmail_emails
ALTER PUBLICATION supabase_realtime ADD TABLE public.gmail_emails;
