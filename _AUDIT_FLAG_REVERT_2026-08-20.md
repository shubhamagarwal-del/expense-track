# Audit flags withdrawn — 20 August 2026

Seven expenses were flagged by Audit for a date mismatch that did not exist. The
flags were withdrawn the same day and the entries returned to `hr_approved`.
Nothing about the expenses themselves was altered.

## What went wrong

The app formats every timestamp in the **viewer's own timezone** — `formatDate`,
`formatDateTime` and the audit table's date column all call `toLocaleDateString`
without pinning a zone. The browser used for audit review had its timezone set to
**UTC−12**, so an expense stored as `2026-05-08T06:53Z` rendered there as
**7 May, 06:53 pm** while the employee, on IST, saw the true **8 May, 12:23 pm**.

Every timestamp before 12:00 UTC therefore displayed **one day earlier** on the
audit screen. Comparing that against the date printed on the receipt showed a
mismatch, and the entry was flagged.

## Why these seven, and only these seven

Two things line up exactly, which is what identifies them:

1. Each of the seven carries an audit note complaining about the date
   ("supporting date different", "Date is different in bus ticket", …).
2. For each, the IST date and the UTC−12 date differ by exactly one day.

Expenses whose UTC time falls after 12:00 show no day shift — and none of those
carry a date complaint. Flags raised for other reasons (category splits, missing
location, hotel invoice not verified) were left untouched; they are unaffected by
the display bug.

## The seven

| Employee | Amount | Shown to Audit | Actual date (IST) | Original flag |
|---|---|---|---|---|
| Parmeshwar Ram Bhat | ₹800 | 30 Apr 2026 | **1 May 2026** | Date is different in bus ticket |
| Vijay Singh Hada | ₹550 | 4 Aug 2026 | **5 Aug 2026** | supporting date is different |
| Md. Shakil Ahmed | ₹187 | 8 May 2026 | **9 May 2026** | supporting date is different |
| Md. Shakil Ahmed | ₹507 | 12 May 2026 | **13 May 2026** | supporting date different |
| Md. Shakil Ahmed | ₹262 | 13 May 2026 | **14 May 2026** | supporting date different |
| Md. Shakil Ahmed | ₹122 | 14 May 2026 | **15 May 2026** | supporting date different |
| Hira Lal Lakhar | ₹200 | 13 Jul 2026 | **14 Jul 2026** | supporting not correct according to date |

## What was changed

Per entry, mirroring the app's own `reopen_audit` action:

- `status` → `hr_approved` (back in Audit's queue)
- `audit_by`, `audit_by_name`, `audit_at`, `audit_note` → cleared
- `reopened_by_name` → "System — date display fix", `reopened_at` → now, so the
  entry carries a re-review marker in the app

A first attempt also wrote the full explanation into `rejection_reason`. That was
undone within the hour: `rejection_reason` renders as a red "Admin Comment" block,
which reads like a rejection and looked alarming on an entry that is perfectly
fine. The field is cleared; the explanation lives in this file and the backup.

Six were at `audit_review` (sitting with HR) and one — Parmeshwar's ₹800 — at
`audit_query` (returned to the employee). All seven are now back with Audit, so
no one has to resubmit.

## Where the evidence lives

- `_backup_audit_flag_revert_1787226860461.json` — every column of all seven rows
  exactly as they stood before the revert, restorable as-is
- The "🔄 Re-reviewed by System — date display fix · 20 Aug" marker on each entry,
  visible in the app, which points back here
- This file

## Still to do

1. **Set the audit machine's timezone to IST.** If a VPN or anti-fingerprinting
   extension is spoofing the timezone, exclude this site. Until then the same
   mistake will repeat.
2. **Pin display formatting to `Asia/Kolkata`** so a misconfigured device can
   never shift a date again. The day-key logic (attendance matching, the daily
   sheet) reads local date parts too and needs the same treatment, but both sides
   of each comparison have to move together — that part needs its own testing.
