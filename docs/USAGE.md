# Usage

## 1. Get the spreadsheet

In Business Profile Manager, select your profiles → **Actions** → **Download** → **Businesses**, tick **Include Google updates**, and save the file as **CSV (UTF-8)** ([Google's steps](https://support.google.com/business/answer/3478406)). Columns the tool reads (English headers, case-insensitive):

| Field | Accepted headers |
|---|---|
| store code (required) | `Store code`, `Business code` |
| name | `Business name`, `Name` |
| address | `Address line 1` … `Address line 5` (or `Address`), `Locality`, `Administrative area`, `Postal code`, `Country / Region` |
| phones | `Primary phone`, `Additional phones` (comma-separated) |
| website | `Website` |
| weekly hours | `Sunday hours` … `Saturday hours` (Google's export), or `Sunday` … `Saturday` |
| special hours | `Special hours` |
| Google's pending updates | `[UPDATED] Sunday hours` … `[UPDATED] Saturday hours`, `[UPDATED] Special hours`, `[UPDATED] Primary phone`, `[UPDATED] Business name`, `[UPDATED] Website`, `[UPDATED] Postal code`, `[UPDATED] Locality`; `Google updates` |

Rows without a store code and repeated store codes are skipped with a warning. A row whose seven day cells are all empty is treated as "no hours provided" rather than "closed all week".

In an `[UPDATED]` column an empty cell means *no update* (Google's definition), unlike your own day cells where empty means closed. `[DELETED]` in an `[UPDATED] … hours` column means Google thinks the location is closed that day.

## 2. Install the extension

`chrome://extensions` → **Developer mode** → **Load unpacked** → select `extension/`. The dashboard opens; choose **Import spreadsheet** and drop the CSV.

## 3. Tell it which page belongs to which profile

Each profile is checked against its `Website` field. If several profiles point to the homepage, open **Pages & settings** and enter each location page. In the popup you can also pick the store code for an unmatched page; the choice is saved.

## 4. Check pages

- **One page:** open it and click the toolbar button. The popup reads the rendered page, so JSON-LD added by JavaScript is included. The badge keeps the number of fails (`!` for warnings only, `✓` for a clean page).
- **All pages:** **Scan all pages** in the dashboard. Chrome asks for access to your site once. Pages that cannot be loaded are listed with the reason.

## 5. Read the result

- **Calendar:** one cell per day of the window. Green = profile and JSON-LD agree, red = they differ, grey = one side unknown, outlined = a special/holiday date. Hover for all three sources.
- **Fails** are contradictions between the profile and the JSON-LD. **Warnings** are missing information or contradictions with the visible text.
- **Drift days** `9/45` = 9 of the 45 days on which both were known differ.
- **Google's pending updates** (drawer, `report.html`, `google-updates.csv`): for each field Google wants to change, what your profile says, what Google proposes, what the page says, and a verdict:
  - *page backs Google* (fail): accept the update in the profile, or fix the page first. Otherwise your own page is the "publicly available information" that supports the edit.
  - *page backs you* (warning): reject the update.
  - *page is silent* / *page shows a third value* (warning): check by hand.
- **The page contradicts itself** (`PAGE_CONSISTENCY`): the JSON-LD and the visible text, or `openingHoursSpecification` and `openingHours`, disagree. Fix that whatever the profile says.

## 6. Fix

- **Website wrong:** copy the **patched** JSON-LD block from the drawer or the popup and paste it over the JSON-LD block it names ("block #1" = the first `<script type="application/ld+json">` on the page). The patch is the page's own block with only `openingHoursSpecification` replaced (future holidays that only the page declares are kept and listed, so you can add them to the profile instead), `openingHours` / `specialOpeningHoursSpecification` removed when present (they would contradict it), and the telephone or address parts the audit flagged. Everything else, including reviews, ratings, images, `geo`, `sameAs`, `@id` and other `@graph` nodes, is kept; the drawer lists what changed and what was kept. Holiday dates use `validFrom`/`validThrough`, as in Google's LocalBusiness documentation, and include every future profile holiday. If your SEO plugin generates the block, put the same hours into the plugin's settings instead of pasting.
- **Page has no LocalBusiness JSON-LD:** the fix is a new minimal block (name, url, telephone, address, hours); add it to the page.
- **Profile missing holiday dates the website announces:** copy the `Special hours` cell, or export `special-hours.csv` (`Store code,Special hours`) and import it in Business Profile Manager. The cell keeps the profile's existing special hours.

## CLI

```text
node bin/drift-inspector.mjs --sheet FILE --as-of YYYY-MM-DD (--pages DIR | --fetch)
                             [--map FILE] [--horizon N] [--out DIR] [--fail-on fail|warn|never]
```

| Option | Meaning |
|---|---|
| `--sheet` | spreadsheet CSV |
| `--as-of` | first day of the window (required so runs are reproducible) |
| `--pages DIR` | saved pages; `DIR/pages.json` maps page URL → file name |
| `--fetch` | download each page (timeout 15 s, follows redirects) |
| `--map FILE` | JSON `{ "store code": "page URL" }` overriding the Website column |
| `--horizon N` | window length in days, 1–366 (default 45) |
| `--out DIR` | write `report.json`, `findings.csv`, `special-hours.csv`, `google-updates.csv`, `report.html` |
| `--fail-on` | exit 1 when any location reaches `fail` (default) or `warn`; `never` always exits 0 |

Exit code 2 means a usage error. Locations whose page cannot be loaded are printed as `SKIP` with the reason.
