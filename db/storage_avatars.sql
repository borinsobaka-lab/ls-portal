-- Storage: avatars bucket policies.
-- Create the bucket manually in Supabase Dashboard (Storage → New bucket)
-- Name: avatars, Public bucket: ON.
-- Then run this SQL to secure access.

-- Public read for avatars bucket
CREATE POLICY IF NOT EXISTS "Avatars public read"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'avatars');

-- Authenticated users can upload only into their own {auth.uid()}/ folder
CREATE POLICY IF NOT EXISTS "Users upload own avatar"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users can update only their own files
CREATE POLICY IF NOT EXISTS "Users update own avatar"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users can delete only their own files
CREATE POLICY IF NOT EXISTS "Users delete own avatar"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
