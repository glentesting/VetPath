-- ============================================================
-- Source of truth for UNDERRATED database schema — March 2026
-- ============================================================
-- Run in Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- All statements use IF NOT EXISTS — safe to re-run.
--
-- Tables:
--   1. profiles         — user profile data (extends auth.users)
--   2. conditions        — VA-rated conditions per user
--   3. uploads           — uploaded document history
--   4. diagnostic_codes  — 38 CFR Part 4 rating criteria
--   5. secondary_connections — documented VA secondary links
--   6. mos_risk_profiles — MOS-specific condition risk data
--   7. dbq_criteria      — C&P exam prep data per condition
--   8. va_knowledge_chunks — indexed text for AI retrieval
-- ============================================================


-- ──────────────────────────────────────────
-- 1. PROFILES — extends Supabase auth.users
-- ──────────────────────────────────────────
-- One row per user. Created on signup/onboarding.
-- Referenced by: every authenticated page, stripe-webhook,
--   delete-account, veteran-context.js

CREATE TABLE IF NOT EXISTS profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan text DEFAULT 'free',                -- 'free' or 'pro' (set by stripe-webhook.js)
  first_name text,
  branch text,                             -- Army, Navy, Marines, Air Force, Coast Guard, etc.
  mos text,                                -- MOS/Rate/AFSC code (e.g. 11B, HM, 3P0X1)
  mos_title text,                          -- Full MOS title (e.g. Infantryman)
  era text,                                -- Service era: post_911, gulf_war, vietnam, etc.
  current_rating integer,                  -- Combined VA disability rating percentage
  state text,                              -- State abbreviation for state benefits
  years_of_service integer,
  dependents integer,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users can view own profile"
  ON profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users can insert own profile"
  ON profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users can update own profile"
  ON profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users can delete own profile"
  ON profiles FOR DELETE TO authenticated
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────
-- 2. CONDITIONS — VA-rated conditions per user
-- ──────────────────────────────────────────
-- Populated by PDF extraction (vault) or manual entry (calculator).
-- Referenced by: dashboard, calculator, gap, claim-builder,
--   nexus-letter, appeal-assistant, vault, tdiu-smc, cp-prep,
--   rating-analyzer, statement-gen, veteran-context.js

CREATE TABLE IF NOT EXISTS conditions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,                      -- Condition name (e.g. "PTSD", "Lumbar strain")
  rating text,                             -- Rating percentage as string (e.g. "70")
  diagnostic_code text,                    -- VA diagnostic code (e.g. "9411")
  decision text,                           -- "Service Connected", "Deferred", "Not Service Connected"
  effective_date text,                     -- Date rating became effective
  sort_order integer DEFAULT 0             -- Display ordering
);

ALTER TABLE conditions ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users can view own conditions"
  ON conditions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users can insert own conditions"
  ON conditions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users can update own conditions"
  ON conditions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users can delete own conditions"
  ON conditions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────
-- 3. UPLOADS — document upload history
-- ──────────────────────────────────────────
-- Logged by api/extract-pdf.js after successful extraction.
-- Referenced by: vault.html (document list), delete-account.js

CREATE TABLE IF NOT EXISTS uploads (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  original_filename text,                  -- Original PDF filename
  file_url text,                           -- Supabase storage URL
  conditions_found integer,                -- Number of conditions extracted
  uploaded_at timestamptz DEFAULT now()
);

ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users can view own uploads"
  ON uploads FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users can insert own uploads"
  ON uploads FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);


-- ──────────────────────────────────────────
-- 4. DIAGNOSTIC CODES — 38 CFR Part 4 rating criteria
-- ──────────────────────────────────────────
-- Lookup table seeded from seed-diagnostic-codes.sql (96 codes).
-- Referenced by: api/analyze-gaps.js, api/analyze-decision.js

CREATE TABLE IF NOT EXISTS diagnostic_codes (
  code text PRIMARY KEY,
  condition_name text NOT NULL,
  body_system text,                        -- e.g. "Musculoskeletal", "Mental Disorders"
  rating_0_criteria text,
  rating_10_criteria text,
  rating_20_criteria text,
  rating_30_criteria text,
  rating_40_criteria text,
  rating_50_criteria text,
  rating_60_criteria text,
  rating_70_criteria text,
  rating_80_criteria text,
  rating_90_criteria text,
  rating_100_criteria text,
  notes text,
  cfr_citation text                        -- e.g. "38 CFR § 4.130, DC 9411"
);

ALTER TABLE diagnostic_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Allow read diagnostic_codes"
  ON diagnostic_codes FOR SELECT TO authenticated USING (true);


-- ──────────────────────────────────────────
-- 5. SECONDARY CONNECTIONS — documented VA secondary links
-- ──────────────────────────────────────────
-- Lookup table seeded from seed-secondary-connections.sql (60 rows).
-- Referenced by: api/analyze-gaps.js, api/analyze-decision.js

CREATE TABLE IF NOT EXISTS secondary_connections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  primary_condition text NOT NULL,
  secondary_condition text NOT NULL,
  relationship_strength text CHECK (relationship_strength IN ('strong','moderate','possible')),
  medical_rationale text,
  cfr_or_precedent text
);

ALTER TABLE secondary_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Allow read secondary_connections"
  ON secondary_connections FOR SELECT TO authenticated USING (true);


-- ──────────────────────────────────────────
-- 6. MOS RISK PROFILES — condition risk by military job
-- ──────────────────────────────────────────
-- Lookup table seeded from seed-mos-profiles.sql (80 codes).
-- Referenced by: api/analyze-gaps.js

CREATE TABLE IF NOT EXISTS mos_risk_profiles (
  mos_code text PRIMARY KEY,
  mos_title text NOT NULL,
  branch text NOT NULL,                    -- Army, Marines, Navy, Air Force, Coast Guard
  high_risk_conditions text[],             -- Array of condition names
  exposure_types text[],                   -- e.g. blast, noise, chemical, burn pit
  common_claims text[],                    -- Most frequently filed conditions for this MOS
  notes text
);

ALTER TABLE mos_risk_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Allow read mos_risk_profiles"
  ON mos_risk_profiles FOR SELECT TO authenticated USING (true);


-- ──────────────────────────────────────────
-- 7. DBQ CRITERIA — C&P exam prep data
-- ──────────────────────────────────────────
-- Lookup table seeded from seed-dbq-criteria.sql (38 conditions).
-- Referenced by: api/cp-prep.js

CREATE TABLE IF NOT EXISTS dbq_criteria (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  condition_name text NOT NULL,
  dbq_form_number text,                    -- e.g. "DBQ 21-0960P-3"
  key_symptoms text[],                     -- Array of symptoms examiner evaluates
  exam_tips text,                          -- Detailed exam preparation guidance
  common_mistakes text                     -- What veterans do wrong at C&P exams
);

ALTER TABLE dbq_criteria ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Allow read dbq_criteria"
  ON dbq_criteria FOR SELECT TO authenticated USING (true);


-- ──────────────────────────────────────────
-- 8. VA KNOWLEDGE CHUNKS — indexed text for AI retrieval
-- ──────────────────────────────────────────
-- Indexed text chunks for search_cfr() RPC function.
-- Referenced by: api/analyze-gaps.js (via RPC)

CREATE TABLE IF NOT EXISTS va_knowledge_chunks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source text,                             -- Source document name
  source_citation text,                    -- Specific citation reference
  content text NOT NULL,                   -- Chunk text content
  condition_tags text[],                   -- Array of related condition names
  chunk_type text                          -- Category of content
);

ALTER TABLE va_knowledge_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Allow read va_knowledge_chunks"
  ON va_knowledge_chunks FOR SELECT TO authenticated USING (true);


-- ──────────────────────────────────────────
-- STORAGE BUCKET (configured via Supabase Dashboard)
-- ──────────────────────────────────────────
-- Bucket: rating-decisions
-- Purpose: stores uploaded VA rating decision PDFs
-- Access: public read (for extract-pdf API), authenticated write
-- Referenced by: vault.html, onboarding.html, calculator.html


-- ──────────────────────────────────────────
-- RPC FUNCTION (if using full-text search)
-- ──────────────────────────────────────────
-- search_cfr(search_term text) — queries va_knowledge_chunks
-- Called by: api/analyze-gaps.js
-- Must be created separately if using CFR search feature
