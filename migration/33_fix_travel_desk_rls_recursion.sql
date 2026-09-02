-- ============================================================
-- Fix: "infinite recursion detected in policy for relation users"
-- The "Travel desk reads all users" policy (from 32_travel_desk.sql) is
-- itself ON public.users and its USING clause queries public.users to
-- check the caller's role — Postgres re-applies every SELECT policy on
-- users (including this one) to that inner query, which recurses forever.
-- Fix: check the role through a SECURITY DEFINER function instead. That
-- function's internal query runs with the function owner's privileges,
-- bypassing RLS, so it doesn't re-trigger this (or any) policy on users.
-- Run this in the Supabase SQL Editor.
-- ============================================================

DROP POLICY IF EXISTS "Travel desk reads all users" ON public.users;

CREATE OR REPLACE FUNCTION public.is_travel_desk()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'travel_desk');
$$;

CREATE POLICY "Travel desk reads all users"
  ON public.users FOR SELECT
  USING (public.is_travel_desk());
