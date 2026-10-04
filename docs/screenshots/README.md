# Screens (text descriptions)

No image files are committed. These descriptions match the UI rendered from `examples/` (`npm run preview`, window 2026-11-20 + 45 days).

## Dashboard — Locations (desktop, 1280 px)

- Left sidebar (208 px): "Location Drift Inspector", then three nav buttons — **Locations** (highlighted), Import spreadsheet, Pages & settings.
- Top bar: title "Locations", subtitle "gbp-locations.csv (sample) · 5 locations"; on the right an *As of* date field, a blue **Scan all pages** button and an **Export** button that opens a menu (report.json, findings.csv, special-hours.csv, google-updates.csv, report.html).
- Amber banner in demo mode only: "Demo mode — running outside the extension on the sample data in examples/. Nothing is saved."
- Four cards: 5 locations in sheet · 5 scanned · 2 with a fail · 57/173 drift days.
- Chart panel "Drift days in the next 45 days": one row per store code with a grey track; NG-BELT empty (0/45), NG-KENS a short red bar with a thin amber bar under it (9/45), NG-AIRP a full red bar (45/45), NG-DTWN "n/a", NG-MAHG a short red bar with a long amber bar under it (3/38). Caption explains thick vs thin bars.
- Table panel with a filter box; columns Store code · Name · Status · Fails · Warnings · Drift days · Page. Sorted by status: NG-KENS FAIL 4 3 9/45, NG-AIRP FAIL 2 1 45/45, NG-DTWN WARN 0 2 0/0, NG-MAHG WARN 0 6 3/38, NG-BELT PASS 0 0 0/45. Rows highlight on hover.
- After a scan a dark toast at the bottom: "Scanned 5 pages".

## Dashboard — detail drawer

Slides in from the right (560 px). Title "NG-KENS · Northgate Rentals Kensington", page URL and "raw HTML (batch scan)". A 45-cell calendar strip: mostly green, red on each Saturday, three outlined red cells for Dec 24–26. Findings list, worst first, each with a coloured chip (FAIL phone, FAIL hours with "Saturday: profile 10:00–14:00 vs page 10:00–16:00", FAIL special hours with three dated lines, FAIL google updates, WARN …, INFO …, then PASS rows). Then a "Google's pending updates · 1" table (Field · Your profile · Google · This page · Verdict, here "Primary phone · 403-555-0120 · 403-555-0129 · 403-555-0129 · FAIL Page backs Google: accept the update or fix the page"). Then "Fix: the page's own JSON-LD, patched": a line naming the block to replace and the properties kept, a bullet list of changes ("openingHoursSpecification: 6 → 6 entries, hours from the profile", "kept 3 dated rule(s) only the page has (2026-12-24, 2026-12-25, 2026-12-26): …", "dropped 1 dated rule(s) that ended before 2026-11-20", "telephone: 403-555-0129 → 403-555-0120"), the full block (WebPage node included) and a **Copy patched JSON-LD block** button; then the Special hours cell with its copy button. Copy buttons briefly read "Copied ✓" with a small pop animation. A History list closes the drawer. For NG-MAHG the change list also shows "removed openingHours (text)" and the kept list includes aggregateRating, geo and image.

## Dashboard — mobile (390 px)

The sidebar becomes a horizontal tab row; tools wrap under the title; cards form a 2 × 2 grid; the chart's labels stay at a readable size; the table scrolls horizontally.

## Popup (400 px)

Header "Location Drift Inspector" with a **Dashboard** button. Status chip and "NG-KENS · Northgate Rentals Kensington", the tab URL, three KPI boxes (fails, warnings, drift days), "Next 14 days · profile vs JSON-LD" strip, the findings list, a grey line "The patch keeps N existing properties and changes only: …", and a blue **Copy patched JSON-LD** button (**Copy new JSON-LD** on a page without LocalBusiness markup) (plus **Copy Special hours cell** when the page announces dates the profile lacks). Empty states: "Import your Business Profile spreadsheet first." and "Open a location page (http or https) and click the toolbar button again."

## report.html

White cards on a light grey page: title "Location drift report", window line, five KPI tiles (the fifth: Google updates backed by your page), a calendar legend, then one card per location with a status chip, URL, metrics line, calendar strip, the list of fails and warnings with their details, a pending-updates table when there are any, and one grey line describing the JSON-LD patch.
