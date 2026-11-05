/**
 * Finds the oldest-touched installed dpkg packages on the host, using each
 * package's `/var/lib/dpkg/info/<name>.list` file mtime as an approximate
 * install date.
 *
 * **Honest methodology caveat**: dpkg doesn't record a true "originally
 * installed" timestamp anywhere queryable. The `.list` file's mtime is
 * updated on *any* dpkg operation touching that package — a reinstall or
 * version upgrade resets it, same as a fresh install. So this genuinely
 * measures "last touched by dpkg," not "originally installed." For most
 * packages (especially base-OS packages that are rarely individually
 * reinstalled) these coincide closely enough to be fun trivia; for
 * frequently-updated packages they won't. `ageDays` should be read as
 * "how long since dpkg last touched this," not a hard install-date claim.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(cmd: string, args: string[]): Promise<CommandResult> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    success: output.success,
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** One `.list` file's package name and mtime, before sorting/filtering. */
export interface ListFileEntry {
  package: string;
  mtimeEpoch: number;
}

/**
 * Parse `find <dir> -maxdepth 1 -name '*.list' -printf '%T@ %p\n'` output
 * (mtime-epoch-then-path, one per line) into package name + mtime pairs.
 * Package name is the filename minus `.list` — dpkg keeps the `:arch`
 * qualifier (e.g. `libc6:arm64`) in the filename itself, which is also
 * exactly the identifier `dpkg-query` accepts, so it's kept verbatim
 * rather than stripped.
 */
export function parseListFiles(output: string, dir: string): ListFileEntry[] {
  const entries: ListFileEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;
    const mtimeEpoch = Number(line.slice(0, spaceIdx));
    const path = line.slice(spaceIdx + 1);
    if (Number.isNaN(mtimeEpoch)) continue;
    const filename = path.slice(dir.length + 1);
    if (!filename.endsWith(".list")) continue;
    entries.push({ package: filename.slice(0, -".list".length), mtimeEpoch });
  }
  return entries;
}

const GlobalArgsSchema = z.object({
  count: z.number().int().positive().default(10).describe(
    "How many of the oldest-touched packages to report.",
  ),
  dpkgInfoPath: z.string().default("/var/lib/dpkg/info").describe(
    "Override for testing or unusual dpkg installs.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const OldestPackageSchema = z.object({
  package: z.string().describe(
    "Package name, with :arch qualifier if dpkg tracks one separately.",
  ),
  currentVersion: z.string().nullable().describe(
    "Current installed version per dpkg-query. Null if the package was removed between listing and querying.",
  ),
  approxTouchedAt: z.string().describe(
    "ISO-8601 timestamp of the .list file's mtime — see module doc for why this is 'last touched,' not a guaranteed original-install date.",
  ),
  ageDays: z.number().describe("Days between approxTouchedAt and capturedAt."),
});

const OldestPackagesSchema = z.object({
  packages: z.array(OldestPackageSchema).describe(
    "The `count` oldest-touched packages, oldest first.",
  ),
  totalPackagesScanned: z.number().describe(
    "Total .list files found — the population this sample was drawn from.",
  ),
  methodology: z.string().describe(
    "Fixed explanatory text about the mtime-as-install-date approximation, included in the data itself so it travels with any report/export of this resource.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: MinimalLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Default textfile-collector path for `exportMetrics`. */
const DEFAULT_PROM_PATH =
  "/var/lib/prometheus/node-exporter/package-archaeology.prom";

/** Escape a Prometheus label value: backslash, then double quote. */
function promEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Render an `oldestPackages` snapshot as Prometheus text-exposition lines,
 * in the exact format run-via-serve.sh's inline Python wrote (the Fun Stuff
 * dashboard reads these names and labels). An empty snapshot omits the
 * oldest-package series rather than guessing one.
 */
export function renderPrometheus(
  snapshot: {
    packages: Array<
      { package: string; currentVersion: string | null; ageDays: number }
    >;
    totalPackagesScanned: number;
  },
): string {
  const out: string[] = [];
  const oldest = snapshot.packages[0];
  if (oldest) {
    out.push(
      "# HELP package_archaeology_oldest_age_days Age in days of the oldest-touched installed package (last dpkg touch, not necessarily original install), labeled with the package's name and version.",
      "# TYPE package_archaeology_oldest_age_days gauge",
      `package_archaeology_oldest_age_days{package="${
        promEscape(oldest.package)
      }",version="${
        promEscape(oldest.currentVersion ?? "")
      }"} ${oldest.ageDays}`,
    );
  }
  out.push(
    "# HELP package_archaeology_total_scanned Total installed packages scanned for this snapshot.",
    "# TYPE package_archaeology_total_scanned gauge",
    `package_archaeology_total_scanned ${snapshot.totalPackagesScanned}`,
  );
  return out.join("\n") + "\n";
}

const METHODOLOGY =
  "approxTouchedAt is the .list file's mtime, which dpkg updates on install, " +
  "reinstall, AND version upgrade alike — this measures 'last touched by dpkg,' " +
  "not a guaranteed original-install date. Read ageDays as fun trivia, not a hard claim.";

/** Model definition for `@aaronge/package-archaeology`. */
export const model = {
  type: "@aaronge/package-archaeology",
  version: "2026.08.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    oldestPackages: {
      description:
        "The oldest-touched installed packages by dpkg .list file mtime.",
      schema: OldestPackagesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    findOldest: {
      description: "List the oldest-touched installed packages on the host.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { count, dpkgInfoPath } = context.globalArgs;
        context.logger.info("Scanning {dpkgInfoPath} for .list files", {
          dpkgInfoPath,
        });

        const find = await runCommand("find", [
          dpkgInfoPath,
          "-maxdepth",
          "1",
          "-name",
          "*.list",
          "-printf",
          "%T@ %p\n",
        ]);
        if (!find.success) {
          throw new Error(
            `find failed on ${dpkgInfoPath}: ${find.stderr.trim()}`,
          );
        }

        const entries = parseListFiles(find.stdout, dpkgInfoPath);
        if (entries.length === 0) {
          throw new Error(
            `No .list files found under ${dpkgInfoPath} — is this a dpkg-based system?`,
          );
        }

        entries.sort((a, b) => a.mtimeEpoch - b.mtimeEpoch);
        const oldest = entries.slice(0, count);

        const capturedAt = new Date();
        const packages = await Promise.all(
          oldest.map(async (entry) => {
            const query = await runCommand("dpkg-query", [
              "-W",
              "-f=${Version}",
              entry.package,
            ]);
            const currentVersion = query.success ? query.stdout.trim() : null;
            const approxTouchedAt = new Date(entry.mtimeEpoch * 1000);
            const ageDays = Math.floor(
              (capturedAt.getTime() - approxTouchedAt.getTime()) /
                (1000 * 60 * 60 * 24),
            );
            return {
              package: entry.package,
              currentVersion,
              approxTouchedAt: approxTouchedAt.toISOString(),
              ageDays,
            };
          }),
        );

        context.logger.info(
          "Oldest package: {oldestPackage}, touched {oldestAgeDays} days ago",
          {
            oldestPackage: packages[0]?.package,
            oldestAgeDays: packages[0]?.ageDays,
          },
        );

        const handle = await context.writeResource(
          "oldestPackages",
          "oldestPackages",
          {
            packages,
            totalPackagesScanned: entries.length,
            methodology: METHODOLOGY,
            capturedAt: capturedAt.toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    exportMetrics: {
      description:
        "Write the oldest package's age and the scan size as a Prometheus " +
        "textfile-collector file. Written atomically (tmp file + rename) " +
        "since node_exporter may be reading the directory concurrently. " +
        "Throws if there is no snapshot yet, leaving any existing file " +
        "alone. Writes no swamp data.",
      arguments: z.object({
        path: z.string().default(DEFAULT_PROM_PATH).describe(
          "Destination .prom file inside node_exporter's textfile directory.",
        ),
      }),
      execute: async (args: { path: string }, context: MethodContext) => {
        const raw = await context.readResource("oldestPackages");
        const parsed = OldestPackagesSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            "No valid oldestPackages snapshot to export — run findOldest first.",
          );
        }
        const body = renderPrometheus(parsed.data);
        const dir = args.path.slice(0, args.path.lastIndexOf("/")) || ".";
        const base = args.path.slice(args.path.lastIndexOf("/") + 1);
        const tmp = await Deno.makeTempFile({ dir, prefix: `.${base}.` });
        try {
          await Deno.writeTextFile(tmp, body);
          await Deno.chmod(tmp, 0o644);
          await Deno.rename(tmp, args.path);
        } catch (err) {
          await Deno.remove(tmp).catch(() => {});
          throw err;
        }
        context.logger.info("Wrote {path}", { path: args.path });
        return { dataHandles: [] };
      },
    },
  },
};
