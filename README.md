# @aaronge/package-archaeology

Finds the oldest-touched installed packages on a Debian/apt-based host —
fun trivia about how long your system has been running and what's
survived on it untouched.

**Methodology, honestly stated**: dpkg doesn't record a true "originally
installed" timestamp anywhere queryable. This model uses each package's
`/var/lib/dpkg/info/<name>.list` file mtime as an approximation — but
that mtime is updated on *any* dpkg operation touching the package (a
reinstall or version upgrade resets it, same as a fresh install). So this
genuinely measures "last touched by dpkg," not "originally installed."
For base-OS packages that are rarely individually reinstalled, the two
usually coincide closely enough to be fun trivia; for frequently-updated
packages they won't. Read `ageDays` as "how long since dpkg last touched
this," not a hard install-date claim — the model's own output includes
this caveat in a `methodology` field so it travels with any report.

## Installation

```sh
swamp extension pull @aaronge/package-archaeology
```

## Usage

```sh
swamp model create @aaronge/package-archaeology my-host

swamp model method run my-host findOldest
```

Writes one resource, `oldestPackages` — the `count` oldest-touched
packages (oldest first), each with its current version, approximate
touch date, and age in days.

## Global arguments

| Arg            | Default              | Notes                                                    |
| -------------- | --------------------- | --------------------------------------------------------- |
| `count`        | `10`                  | How many oldest-touched packages to report.               |
| `dpkgInfoPath` | `/var/lib/dpkg/info`  | Override for testing or unusual dpkg installs.             |

## How it works

- **`findOldest`** — lists every `.list` file under `dpkgInfoPath` with
  its mtime (via `find -printf '%T@ %p'`), sorts ascending, and reports
  the oldest `count` along with each package's current version (via
  `dpkg-query`). A package removed between listing and querying reports
  `currentVersion: null` rather than failing the whole run.

## Workflow

None bundled. Run `findOldest` whenever curiosity strikes — it's a cheap,
read-only filesystem scan (no network, no root required).

## License

MIT — see LICENSE for details.
