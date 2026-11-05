import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  model,
  parseListFiles,
  renderPrometheus,
} from "./package_archaeology.ts";

function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = { count: 3, dpkgInfoPath: "/var/lib/dpkg/info" };

// --- parseListFiles ----------------------------------------------------------

Deno.test("parseListFiles parses find's mtime-epoch-then-path output", () => {
  const output = "1759280661.117263121 /var/lib/dpkg/info/debconf.list\n" +
    "1787979361.801319115 /var/lib/dpkg/info/ffmpeg.list\n";
  const result = parseListFiles(output, "/var/lib/dpkg/info");
  assertEquals(result.length, 2);
  assertEquals(result[0], {
    package: "debconf",
    mtimeEpoch: 1759280661.117263121,
  });
  assertEquals(result[1], {
    package: "ffmpeg",
    mtimeEpoch: 1787979361.801319115,
  });
});

Deno.test("parseListFiles keeps the :arch qualifier in the package name", () => {
  const output = "1787979361 /var/lib/dpkg/info/libswresample5:arm64.list\n";
  const result = parseListFiles(output, "/var/lib/dpkg/info");
  assertEquals(result[0].package, "libswresample5:arm64");
});

Deno.test("parseListFiles skips blank lines and non-.list entries", () => {
  const output = "\n1787979361 /var/lib/dpkg/info/ffmpeg.list\n\n";
  const result = parseListFiles(output, "/var/lib/dpkg/info");
  assertEquals(result.length, 1);
});

Deno.test("parseListFiles returns empty for empty input", () => {
  assertEquals(parseListFiles("", "/var/lib/dpkg/info"), []);
});

// --- findOldest ----------------------------------------------------------------

const MOCK_FIND_OUTPUT = "1759280661 /var/lib/dpkg/info/base-passwd.list\n" +
  "1759280700 /var/lib/dpkg/info/apt.list\n" +
  "1787979361 /var/lib/dpkg/info/ffmpeg.list\n" +
  "1788000000 /var/lib/dpkg/info/newest-pkg.list\n";

Deno.test("findOldest returns the N oldest packages, sorted ascending, with versions", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "findOldest",
  });

  await withMockedCommand((command, args) => {
    if (command === "find") return { stdout: MOCK_FIND_OUTPUT, code: 0 };
    if (command === "dpkg-query") {
      const pkg = args[args.length - 1];
      return { stdout: `1.0-${pkg}`, code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.findOldest.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    packages: { package: string; currentVersion: string; ageDays: number }[];
    totalPackagesScanned: number;
  };
  assertEquals(data.totalPackagesScanned, 4);
  assertEquals(data.packages.length, 3);
  assertEquals(data.packages[0].package, "base-passwd");
  assertEquals(data.packages[1].package, "apt");
  assertEquals(data.packages[2].package, "ffmpeg");
  assertEquals(data.packages[0].currentVersion, "1.0-base-passwd");
  assert(
    data.packages[0].ageDays > data.packages[2].ageDays,
    "oldest package should have the largest ageDays",
  );
});

Deno.test("findOldest reports null currentVersion when dpkg-query fails (package removed since listing)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { count: 1, dpkgInfoPath: "/var/lib/dpkg/info" },
    methodName: "findOldest",
  });

  await withMockedCommand((command) => {
    if (command === "find") {
      return {
        stdout: "1759280661 /var/lib/dpkg/info/gone-pkg.list\n",
        code: 0,
      };
    }
    if (command === "dpkg-query") {
      return {
        stdout: "",
        stderr: "no packages found matching gone-pkg",
        code: 1,
      };
    }
    throw new Error(`unexpected command in test: ${command}`);
  }, () => model.methods.findOldest.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    packages: { currentVersion: string | null }[];
  };
  assertEquals(data.packages[0].currentVersion, null);
});

Deno.test("findOldest includes the methodology caveat in written data", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "findOldest",
  });

  await withMockedCommand((command, args) => {
    if (command === "find") return { stdout: MOCK_FIND_OUTPUT, code: 0 };
    if (command === "dpkg-query") return { stdout: "1.0", code: 0 };
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.findOldest.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as { methodology: string };
  assert(data.methodology.includes("last touched by dpkg"));
});

Deno.test("findOldest throws when find fails entirely", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "findOldest",
  });

  await assertRejects(
    () =>
      withMockedCommand(
        (command) => {
          if (command === "find") {
            return {
              stdout: "",
              stderr: "permission denied",
              code: 1,
            };
          }
          throw new Error(`unexpected command in test: ${command}`);
        },
        () => model.methods.findOldest.execute({}, asContext(context)),
      ).then((r) => r.result),
    Error,
    "find failed",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("findOldest throws when no .list files are found at all", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "findOldest",
  });

  await assertRejects(
    () =>
      withMockedCommand(
        (command) => {
          if (command === "find") return { stdout: "", code: 0 };
          throw new Error(`unexpected command in test: ${command}`);
        },
        () => model.methods.findOldest.execute({}, asContext(context)),
      ).then((r) => r.result),
    Error,
    "No .list files found",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("renderPrometheus: matches the old textfile format", () => {
  assertEquals(
    renderPrometheus({
      packages: [{ package: "apt", currentVersion: "3.0.3", ageDays: 400 }],
      totalPackagesScanned: 1946,
    }),
    "# HELP package_archaeology_oldest_age_days Age in days of the oldest-touched installed package (last dpkg touch, not necessarily original install), labeled with the package's name and version.\n" +
      "# TYPE package_archaeology_oldest_age_days gauge\n" +
      'package_archaeology_oldest_age_days{package="apt",version="3.0.3"} 400\n' +
      "# HELP package_archaeology_total_scanned Total installed packages scanned for this snapshot.\n" +
      "# TYPE package_archaeology_total_scanned gauge\n" +
      "package_archaeology_total_scanned 1946\n",
  );
});

Deno.test("renderPrometheus: null version renders empty, empty snapshot omits oldest", () => {
  const text = renderPrometheus({
    packages: [{ package: "gone", currentVersion: null, ageDays: 1 }],
    totalPackagesScanned: 1,
  });
  assert(text.includes('{package="gone",version=""} 1'));
  const empty = renderPrometheus({ packages: [], totalPackagesScanned: 0 });
  assert(!empty.includes("oldest_age_days"));
});
