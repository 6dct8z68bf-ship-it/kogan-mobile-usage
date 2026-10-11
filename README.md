# Kogan Mobile data usage report

Signs in to [Kogan Mobile](https://accounts.koganmobile.com.au/customer/login),
fetches the **Data Usage** from Usage History, cleans it up and renders a
standalone HTML report.

Supports multiple phone numbers, can be re-run at any time, and can open the
report for you when it finishes.

## Requirements

- **Nothing to install.** `run.cmd` finds a usable Node.js by itself, in this order:
  the system `PATH`, the usual install locations, then the Node runtime bundled
  with the Codex desktop app.
- Only Node built-ins are used (`fetch`, `fs`, ...). There are **no npm
  dependencies**, so there is no `npm install` step.
- If you install [Node.js LTS](https://nodejs.org/) yourself, `node src/index.js`
  and the npm scripts in `package.json` work directly.

Where Node comes from matters: if `node` is not on your `PATH`, `run.cmd` falls
back to the runtime shipped with the Codex desktop app
(`%USERPROFILE%\.cache\codex-runtimes\...\node.exe`). That runtime belongs to the
app, ships without `npm`, and may move or disappear when Codex updates. Install
Node.js LTS if you want this tool to be independent of Codex.

## Quick start

1. Copy `.env.example` to `.env` and fill in your phone numbers and PINs:

   ```
   KOGAN_ACCOUNTS=0400000000:123456
   ```

   Separate multiple numbers with a comma or a newline:

   ```
   KOGAN_ACCOUNTS=0400000000:123456,0455555555:654321
   ```

   The numbered form works too: `KOGAN_MSISDN_1=...` plus `KOGAN_PIN_1=...`.

2. Check that sign-in works (no report is generated, it only signs in and parses):

   ```
   .\run.cmd check
   ```

3. Generate the report:

   ```
   .\run.cmd
   ```

   It writes `out/usage-report.html` by default. Add `--open` to launch it in your
   browser. The simplest option is to just double-click `run.cmd`.

## Command line options

| Option | Description | Default |
| --- | --- | --- |
| `-f`, `--fixture <file>` | build the report from a saved usage HTML file (repeatable, no sign-in) | — |
| `--env <file>` | path to `.env` | `./.env` |
| `--months <1\|3\|6>` | period to fetch, matching "Your usage in the last" | `1` |
| `--type <type>` | `All` / `Data` / `SMSMMS` / `Calls` | `Data` |
| `--min-mb <n>` | ignore records below this many MB | `1` |
| `--highlight-mb <n>` | highlight records above this many MB | `50` |
| `--mb-base <n>` | bytes per MB for rows shown as `B` (`1048576` binary / `1000000` decimal) | `1048576` |
| `--project-until <date>` | project the cumulative usage line up to this date (`YYYY-MM-DD`) | `2027-10-06` |
| `--lang <zh\|en>` | default report language and console language | `zh` |
| `--redact` | replace phone numbers with `Account 1`, `Account 2`, ... (owner names stay) | off |
| `--mask-numbers` | show phone numbers as `040****123` instead of `Account 1` (owner names stay) | off |
| `--hide-names` | also hide the owner names (use with `--redact`) | off |
| `-o`, `--out <file>` | output HTML path | `out/usage-report.html` |
| `--save-raw <dir>` | keep the fetched raw HTML (useful for debugging) | `out/raw` |
| `--no-save-raw` | do not keep the fetched raw HTML | — |
| `--open` | open the report with the default browser | — |

`--months` mirrors the dropdown on the website, and that dropdown only offers
**1 / 3 / 6 months** — the 12 month entry is commented out in the site's own HTML
(`<!--option value="12">Year</option-->`), so this tool rejects 12 as well. How far
back the data actually goes also depends on when the number was activated (for
example `SMALL 365 FLEX` is a 365 day plan).

Examples:

```
.\run.cmd --months 3 --open
.\run.cmd --type All --out out/all-usage.html
.\run.cmd --fixture "Usage History.html"          # offline mode
```

(`.\run.cmd` is the same as `node src/index.js`, it just locates Node for you.)

Matching `.env` variables: `KOGAN_MONTHS`, `KOGAN_USAGE_TYPE`, `KOGAN_MIN_MB`,
`KOGAN_HIGHLIGHT_MB`, `KOGAN_MB_BASE`, `KOGAN_LANG`, `KOGAN_OWNERS`,
`KOGAN_OUT_FILE`. Command line options take precedence over `.env`.

## Owner names (optional)

Map a phone number to the person using it with `KOGAN_OWNERS` in `.env`:

```
KOGAN_OWNERS=0400000001:Alice,0400000002:Bob,0400000003:Carol,0400000004:Dave
```

Three forms are supported, with the precedence "inline > `KOGAN_OWNERS` >
`KOGAN_NAME_n`":

| Form | Example |
| --- | --- |
| Inline (third field) | `KOGAN_ACCOUNTS=0400000001:123456:Alice,0400000002:654321:Bob` |
| Lookup list | `KOGAN_OWNERS=0400000001:Alice,0400000002:Bob` |
| Numbered | `KOGAN_NAME_1=Alice` (next to `KOGAN_MSISDN_1` / `KOGAN_PIN_1`) |

Names show up in each account's section heading, in the "Owner" column of the
all-accounts overview table, and in the console output. When no names are set the
report simply shows the phone numbers and omits the extra column.

## Language

The report has a Chinese / English switch in the top right corner. Both languages
are embedded in the same HTML file, so switching needs no re-render and still
works with JavaScript disabled. The initial language comes from `--lang` or
`KOGAN_LANG` (default `zh`), and the choice is remembered in the browser's
localStorage.

Console output follows `--lang` too, so `--lang en` gives an entirely English run:

```
node src/index.js --lang en --out out/report-en.html
```

## Cleanup rules

| Rule | Behaviour |
| --- | --- |
| Below `--min-mb` (default 1 MB) | **Ignored**, not listed in the detail table; still counted in the footer as "N records / X MB ignored" |
| Above `--highlight-mb` (default 50 MB) | **Highlighted**: red row background, red left border, a `High` badge, plus a one-click "Only > 50 MB" filter |
| Boundaries | Exactly 1 MB is kept; exactly 50 MB is not highlighted (strictly greater only) |
| Data only | Rows whose `Type` contains `Data` or whose `Number` is `Internet`; calls and SMS/MMS are counted but excluded from the MB totals |
| Duplicates | Rows with the same date, time, type, country, number and value are treated as duplicates and dropped (useful when merging several queries) |
| Units | Everything is normalised before any maths, then displayed back in MB |

The report cross-checks the parsed total against the `Charged` footer on the
website, and marks it "✓ Matches the page footer" when the difference is inside
the rounding of the displayed values.

## What the report contains

- Header with the generation time (Australia/Sydney), the source URL and the MB definition used
- Language switch (Chinese / English, Chinese by default)
- One card per phone number: total usage after cleanup, high-usage count / total / share, ignored count, largest and average record
- Daily usage bar chart (a flag marks days with a single record above 50 MB)
- Cumulative usage line chart with the current average rate projected forward to
  `--project-until` (the plan expiry by default), plus a "Projected by" column in
  the all-accounts overview table, so you can see where each number is heading
- Usage detail table (newest first): date, time, type, country, usage, distribution, share, status
- Daily summary table: records, usage, share, largest record, high-usage count
- Cleanup rules and data quality: thresholds, footer cross-check, excluded call/SMS counts
- With several numbers, an "All accounts overview" table at the top

The report is a single HTML file with the CSS and the filter JavaScript inlined,
so it opens offline and can be shared as-is.

## How it works

The site is a classic form-based application, so no browser is needed:

1. `GET /customer/login` — grab the `csrfToken` and the `clientsession` cookie
2. `POST /customer/login` — send `csrfToken` + `user_name` (phone) + `user_password` (PIN)
3. `GET /service/usage` — grab that page's `csrfToken`
4. `POST /service/usage` — send `usage-history-form[type]` + `usage-history-form[months]`
5. Parse every `<tr>` of `<table id="service-usage-history">`
6. Clean the data and render the HTML

Cookies are managed by the tool itself (including following redirects), so every
request after sign-in carries the session.

## Project layout

```
src/index.js              CLI entry point: argument parsing, orchestration, output
src/env.js                .env reading, accounts and owner names
src/http-session.js       small HTTP client (cookie jar + redirects)
src/kogan-client.js       sign-in, usage page fetching, error classification
src/parse-usage.js        usage table -> structured data
src/clean-usage.js        unit conversion, thresholds, highlighting, daily rollups
src/units.js              size and duration parsing
src/render-report.js      standalone HTML generation
src/report.css            report styles (inlined into the HTML)
src/html.js               small HTML entity / tag helpers
src/i18n.js               zh / en message catalog for the CLI and console
scripts/check-login.js    sign-in self check
test/run-tests.js         unit + fixture tests
run.cmd                   Windows launcher (finds Node for you)
fixtures/                 saved sample page (contains a real phone number, do not share)
reference/login-page.html saved sign-in page, kept for debugging comparisons
```

## Run it on a schedule with GitHub Actions

`.github/workflows/daily-usage-report.yml` signs in on a schedule, rebuilds the
report and publishes it to GitHub Pages. The report is a build output, so it is
never committed: the repository keeps the source, and the report arrives either
as the web page or as a workflow artifact with 30 days of retention.

It runs at `17 */3 * * *` UTC — every three hours, at 17 minutes past, which is
02:17, 05:17, 08:17, 11:17, 14:17, 17:17, 20:17 and 23:17 in Sydney. The minute is
deliberately not `0`: GitHub's scheduler is at its busiest exactly on the hour,
where runs are delayed or even dropped, and GitHub's own advice is to schedule
"at a different time of the hour".

It also has a manual trigger: **Actions → Usage report → Run workflow**. A
manual run takes three optional inputs, which apply to that single run only:

| Input | Options | Default |
| --- | --- | --- |
| `months` | `1`, `3`, `6` | `6` |
| `type` | `Data`, `All`, `SMSMMS`, `Calls` | `Data` |
| `lang` | `en`, `zh` | `en` |

Scheduled runs have no inputs, so they fall back to the defaults written into
the workflow's "Write .env" step — currently 6 months, `Data`, `en`. Keep those
two sets of defaults in step with each other. A repository variable of the same
name, if you set one, takes priority over both.

The same inputs work from the command line, for example
`gh workflow run daily-usage-report.yml -f months=3`.

Because nothing is pushed back, the workflow keeps working unchanged even when
`main` is protected with "Require a pull request before merging".

## Making changes to this repository

`main` is protected, so every change goes through a pull request:

| Rule | Value |
| --- | --- |
| Require a pull request before merging | on |
| Required approvals | 1 |
| Require review from Code Owners | on (`CODEOWNERS` assigns everything to `@henryliu18`) |
| Include administrators | on, so nobody can bypass the rules |

GitHub does not let an account approve its own pull request, so the two accounts
have to approve each other's work:

| Pull request opened by | Must be approved by |
| --- | --- |
| `6dct8z68bf-ship-it` | `henryliu18` |
| `henryliu18` | `6dct8z68bf-ship-it` |

Keep both accounts accessible. The bypass list is empty, so a pull request can
only be merged once the code owner has approved it.

The same run publishes the report to GitHub Pages, so the latest version is one
tap away on a phone:

```
https://6dct8z68bf-ship-it.github.io/kogan-mobile-data-usage/
```

Because both the repository and that page are public, the workflow always runs
with a redaction flag, and the owner names from `KOGAN_ACCOUNTS` are kept as
labels. Two label styles are available:

| Flag | The phone number appears as | Notes |
| --- | --- | --- |
| `--mask-numbers` | `040****123` | still recognisable to you, but the first and last three digits stay visible |
| `--redact` | `Account 1`, `Account 2`, ... | nothing of the number is published; numbering follows the order in `KOGAN_ACCOUNTS` |

`--mask-numbers` wins if both are set. **Whatever you put in the name field of
`KOGAN_ACCOUNTS` becomes public**, so use a nickname rather than a real name, and
add `--hide-names` if you would rather publish the labels only. Never commit or
publish a report that was generated without one of these flags.

### Repository secret

| Name | Value |
| --- | --- |
| `KOGAN_ACCOUNTS` | The same string you would put in `.env`, for example `0400000001:123456:Alice,0400000002:654321:Bob` |

This is one secret holding every number and PIN, in the exact `phone:PIN:Name`
format the `.env` file uses. Add it under **Settings → Secrets and variables →
Actions → Secrets**. It is only written to `.env` for the duration of the job,
never echoed, and deleted again by an always-run cleanup step.

### Repository variables (optional)

Non-sensitive settings belong in **Settings → Secrets and variables → Actions →
Variables**. Anything omitted falls back to the default in the table:

| Name | Default |
| --- | --- |
| `KOGAN_MONTHS` | `1` |
| `KOGAN_USAGE_TYPE` | `Data` |
| `KOGAN_MIN_MB` | `1` |
| `KOGAN_HIGHLIGHT_MB` | `50` |
| `KOGAN_LANG` | `en` |

Do not put credentials in variables: unlike secrets, their values are not masked
in the workflow log.

### Notes and caveats

- The fetched pages are never saved in CI (`--no-save-raw`), so full phone
  numbers from the call records do not end up in the workspace.
- `out/` is ignored entirely: the generated report and any fetched pages never
  reach the repository.
- GitHub-hosted runners sit in Azure datacenters, not on an Australian
  residential connection. Kogan's sign-in page is behind an F5 WAF, so a login
  from that network may be challenged or blocked. If the scheduled runs start
  failing, that is the first thing to check.
- Scheduled runs can be delayed, and the cron time is fixed in UTC, so the local
  time shifts by an hour when daylight saving changes.

## Troubleshooting

| Error code | Meaning and what to do |
| --- | --- |
| `LOGIN_FAILED` | Wrong phone number or PIN. Check that the PIN is 6 digits and that the number is written the way you type it on the site |
| `LOGIN_PAGE_CHANGED` | No `csrfToken` on the sign-in page; the site layout changed and `src/kogan-client.js` needs updating |
| `USAGE_PAGE_CHANGED` | No `csrfToken` on the usage page; same as above |
| `SESSION_LOST` | Redirected back to the sign-in page; usually a dropped session, just re-run |
| `TABLE_NOT_FOUND` | The `service-usage-history` table is missing; the layout may have changed, or there is no usage data |
| Footer cross-check fails | The parsed data does not match the site total. Use `--save-raw` to keep the HTML and inspect it |

## Security

- `.env` is listed in `.gitignore` and is never committed.
- Credentials are stored in plain text in `.env`. Keep that file readable only by
  you and do not paste it anywhere.
- This tool signs in to a telco account automatically. Check that this is
  acceptable under Kogan Mobile's terms of service, and accept the risk of the
  account being flagged (the tool only performs the sign-in and browsing a normal
  user would do).

## Tests

```
.\run.cmd test
```

This covers unit conversion, `.env` parsing, the sample page (56 rows: 23 kept,
8 ignored, 5 highlighted, 1103.23 MB total), boundary values, bilingual HTML
output and owner names.

## License

MIT. See [LICENSE](LICENSE).
