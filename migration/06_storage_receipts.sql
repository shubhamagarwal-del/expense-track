-- Create the receipts bucket (private — signed URLs used for viewing)
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload files into their own folder (userId/*)
DROP POLICY IF EXISTS "Users can upload own receipts" ON storage.objects;
CREATE POLICY "Users can upload own receipts"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'receipts'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow authenticated users to update/replace their own files
DROP POLICY IF EXISTS "Users can update own receipts" ON storage.objects;
CREATE POLICY "Users can update own receipts"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'receipts'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
