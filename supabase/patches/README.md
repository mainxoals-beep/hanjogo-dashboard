# Server sync egress fix — 2026-09-26

`refresh-participant-count-egress.patch` records the two-line change applied
to the existing `refresh-participant-count` Edge Function (version 1 to 2).
It applies to that function's `index.ts`, not the dashboard frontend.
The full deployed source is retained in Supabase; it is not copied here
because it contains an existing private cron credential.

The sync only needs the configured participant CSV URL. Project that field
in PostgREST rather than downloading the entire dashboard JSON.
The schedule, CSV parsing, count calculation, update RPC, timestamps and
authentication are unchanged. No database migration is needed.

Validation: the old and new read returned the same CSV URL. At the time of
measurement, uncompressed JSON responses were 440,533 bytes and 182 bytes
respectively (99.96% smaller). This measures the changed read only, not
total organization egress or billed transfer after compression.
