-- Migration 010: Backfill via_source for non-Prisjakt rows
-- Rows inserted before migration 009 by dedicated scrapers (elgiganten, webhallen, etc.)
-- have via_source = NULL. Without this backfill, those rows are unprotected and could
-- be overwritten by Prisjakt's merchant-row extraction.
-- Setting via_source = retailer ensures the protection guard fires correctly.

UPDATE dsc_prices
SET
    via_source = retailer
WHERE
    via_source IS NULL
    AND retailer != 'prisjakt';