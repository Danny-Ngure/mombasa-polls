# Mombasa Ni Yetu Polls

A public opinion poll on the Mombasa governorship race. Voters choose a
candidate, fill in their details, and immediately see live results — **percentages only** —
plus anonymised demographics. Constituency is collected but never shown publicly.

> **This is an unofficial public opinion poll.** It is not an election, not an official
> result, and is not affiliated with the IEBC, any candidate or any political party.
> Candidate names and party logos are used for identification only.

---

## Candidates

Names are spelled exactly as supplied and must not be changed. Each photo and logo is
mapped to its candidate by filename:

| Candidate | Party | Photo (source file) | Logo (source file) |
|---|---|---|---|
| Hassan Omar Sarai | UDA | `HASSAN OMAR SARAI.jpg` | `United_Democratic_Alliance_(Kenya)_logo.png` |
| Abdulswamad Sharif Nasir | ODM | `HE-Abdulswamad SHARIF NASIR.jpg` | `ODM PARTY.jpg` |
| Ali Mbogo Menza | Linda Mwananchi Party | `ALI MBOGO MENZA.jpg` | `LINDA MWANAINCHI.png` |
| Suleiman Shabal | TND | `SHABAL.jpg` | `TND PARTY.jpg` |
| Mohammed Ali Jicho Pevu | WIPER | `JICHO PEVU.jpg` | `WIPER.png` |

The party label reads **Linda Mwananchi Party**, confirmed by the poll owner. (The brief
said "Part"; the supplied logo artwork reads "LINDA MWANANCHI", while the filename reads
"MWANAINCHI". The owner chose "Linda Mwananchi Party".)

---

## What is in this repository

| Path | What it is |
|---|---|
| `mombasa-ni-yetu-polls.html` | The Claude-hosted portal (live now, invite-only). Single file. |
| `server/` | The public deployment: Node + Express + Socket.IO + SQLite/Postgres. |
| `*.jpg`, `*.png` | The supplied candidate photos and party logos. |

### Two ways to run the poll

**1. Claude-hosted (live already).** A working HTTPS portal with a real shared database,
live results and the admin panel built in. Only people you invite — signed in to Claude —
can cast a vote; anyone else sees it read-only. Good for a controlled panel, not a public
Mombasa-wide poll.

**2. Public deployment (`server/`).** A normal website anyone can vote on from any browser,
no account needed. This is the one to use for the real public poll. It needs your own
hosting account to go live — see below.

---

## Deploying the public poll

### One-click on Render (free tier)

1. Push this repository to GitHub.
2. Generate your secrets locally:
   ```bash
   cd server && npm install && npm run keys -- "YourStrongAdminPassword"
   ```
3. In Render: **New → Blueprint →** pick the repo. `server/render.yaml` creates the web
   service and a Postgres database and generates the encryption keys automatically.
4. Set the one variable Render cannot generate: `ADMIN_PASSWORD_HASH`, from step 2.
5. Deploy. Your public HTTPS URL is live, with the poll **closed** until you start it.

### Anywhere else

Any host that runs Node 22+ works. `Dockerfile` is included.

```bash
cd server
npm ci --omit=dev
NODE_ENV=production node src/index.js
```

Set `DATABASE_URL` for Postgres, or leave it unset to use the built-in SQLite file at
`SQLITE_PATH` — **if you use SQLite, mount a persistent disk on `server/data/`**, or votes
are lost when the container restarts. All configuration is in `server/.env.example`.

### Running it locally

```bash
cd server && npm install && npm run dev
```

Open <http://localhost:3000>. In development the app generates throwaway secrets and the
admin password is `mombasa-dev`. In production it refuses to start without real secrets.

---

## Running the poll

Sign in at **`/admin`** with `ADMIN_USER` and your password.

| Action | Effect |
|---|---|
| **Open poll** | Opens voting. Nobody can vote before this; it then runs until you close it. |
| **Close poll now** | Stops voting immediately. |
| **Export CSV** | Full submissions including names and constituency. Admin only. |
| **Mark invalid** | Excludes a vote from the tally. Public percentages update instantly. |
| **Run retention purge** | Destroys names and constituencies older than `RETENTION_DAYS`. |

The poll has no automatic end: it runs until you press **Close poll now**.
`AUTO_START_POLL=true` opens it on first boot.

---

## Results policy: percentages only

At the poll owner's instruction, **no vote counts and no voter numbers are shown publicly**.
This is enforced on the server, not just in the interface: `/api/results` and the websocket
feed serialise percentages only, so counts cannot be recovered by reading network traffic.
Counts exist solely in the admin panel and CSV export.

Percentages use largest-remainder rounding, so displayed shares always total exactly 100.0%.

**One caveat worth knowing:** with the denominator hidden, early results look dramatic —
the first vote makes someone 100%. Consider starting the poll once you have a few voters
ready, or ask me to add a "results open after N votes" threshold.

---

## Privacy

- **Constituency is never public.** It is collected, encrypted, and used only in the admin
  panel. No public report breaks results down by constituency.
- **Names are never public.** Stored encrypted for verification and audit only.
- **Encryption at rest.** Name, constituency and self-described gender are encrypted with
  AES-256-GCM (`DATA_ENCRYPTION_KEY`) before they touch the database. Verified: those values
  do not appear in plaintext anywhere in the database files.
- **No raw IPs or phone numbers are stored**, only keyed one-way hashes (`HASH_PEPPER`).
- **Retention.** `RETENTION_DAYS` (default 30). The purge destroys names, constituencies and
  network hashes while keeping the anonymous tally, so results survive and personal data
  does not. Run `npm run purge` on a schedule, or press the button in `/admin`.
- Set a **data-deletion contact address** in `/admin`; it appears in the public footer.

Changing `DATA_ENCRYPTION_KEY` makes existing names and constituencies permanently
unreadable. Keep it safe.

---

## One vote per person, and its limits

The poll owner chose **no OTP and no CAPTCHA** — people fill in the form and vote. Be clear
about what that does and does not buy you:

**Active now**
- Signed, HTTP-only device cookie; one vote per device, enforced by a database uniqueness
  constraint, not just a check.
- Per-IP ceiling (`MAX_VOTES_PER_IP`, default 25) and a sliding-window rate limit.
- Suspicious-pattern flags (repeat IP, missing user-agent) recorded for admin review and
  shown in the CSV. Flagged votes are never auto-rejected — a human decides.
- All tallying server-side. The browser is never trusted with counts.
- Audit trail of every administrative action, with hashed voter references.

**What this will not stop:** one determined person voting from several devices, browsers or
networks. Treat the result as an opinion poll, not a verified headcount.

### Turning verification on

No rebuild needed — both layers are implemented and config-gated:

```bash
OTP_ENABLED=true
OTP_PROVIDER=africastalking   # or twilio
AT_USERNAME=...
AT_API_KEY=...
```

A phone code is then required before a ballot is accepted, and the number is stored only as
a salted hash with a uniqueness constraint (one vote per number). Expect roughly KES 1 per
SMS. For hCaptcha, set `CAPTCHA_ENABLED=true` with `HCAPTCHA_SITE_KEY` and `HCAPTCHA_SECRET`.

---

## Security notes

- Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- Cross-origin state-changing requests refused.
- Admin password stored as an scrypt hash; sign-in is rate-limited and failures are audited.
- The admin interface is a separate page — its markup is never served to voters.
- `.env` and `data/` are gitignored. Never commit secrets.

---

## What was tested

Verified end to end against a running server:

- Results are refused before voting (`/api/results` → 403) and after a reload without voting.
- Voting is refused before the poll opens and after it closes.
- A second vote from the same device is rejected.
- Failed form validation does not consume a voter's rate-limit budget.
- Public payload contains no integer other than percentages and a timestamp; shares total 100.0%.
- Admin endpoints reject unauthenticated requests.
- Names, constituencies and self-described gender are absent in plaintext from the database
  files, confirmed against a positive control that *is* found in plaintext.
- Marking a vote invalid immediately changes the public percentages.
- The retention purge removes PII and leaves the tally intact.
- All five candidate photos and party logos load and are matched to the right candidate.

Not tested: a real SMS provider (no account), hCaptcha (no keys), Postgres (tested on
SQLite; the Postgres adapter shares the same interface), and load behaviour under
concurrency.

---

## Legal and ethical

Confirm compliance with Kenyan election law and the **Data Protection Act, 2019** before
publishing results. Publish them only as an unofficial opinion poll, never as an election
result. Honour data-deletion requests — the retention purge and the per-record controls in
`/admin` exist for that. Keep the unofficial-poll notice visible; it is built into both the
public page and the admin panel and should not be removed.
