using System;
using System.Collections.Generic;

// Compiled together with the production PdfWorkerGuard.cs via:
//   csc /main:PdfMemoryPolicyTests PdfWorkerGuard.cs PdfMemoryPolicyTests.cs
// Only the two production helpers are exercised: PdfMemoryPolicy.RuntimeLimit
// (defaults/validation) and PdfMemoryPolicy.Below (strict byte boundary).
public static class PdfMemoryPolicyTests {
  const ulong MiB = 1048576UL;
  static int passed, failed;

  static void Check(string name, Action test) {
    try {
      test();
      passed++;
      Console.WriteLine("ok " + (passed + failed) + " - " + name);
    } catch (Exception error) {
      failed++;
      Console.WriteLine("not ok " + (passed + failed) + " - " + name);
      Console.WriteLine("  " + error.GetType().Name + ": " + error.Message);
    }
  }

  static void Eq<T>(T expected, T actual, string what) {
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
      throw new Exception(what + ": expected " + expected + ", got " + actual);
  }

  static void Throws(Action action, string expectedText) {
    try {
      action();
    } catch (Exception error) {
      if (error.Message.IndexOf(expectedText, StringComparison.Ordinal) >= 0) return;
      throw new Exception("wrong validation error: " + error.Message);
    }
    throw new Exception("expected validation error containing: " + expectedText);
  }

  public static int Main(string[] args) {
    Console.WriteLine("TAP version 13");

    Check("legacy JSON without runtime keeps the startup value for both stages", () => {
      Eq(3072, PdfMemoryPolicy.RuntimeLimit(3072, 0), "old default");
      Eq(512, PdfMemoryPolicy.RuntimeLimit(512, 0), "old 512 stays legal");
    });

    Check("new JSON uses 1024 runtime, keeps 1792 startup, and allows equality", () => {
      Eq(1024, PdfMemoryPolicy.RuntimeLimit(1792, 1024), "runtime floor");
      Eq(1792, PdfMemoryPolicy.RuntimeLimit(1792, 1792), "runtime equals startup");
      Eq(1792, PdfMemoryPolicy.RuntimeLimit(1792, 0), "old helper view of the same JSON");
    });

    Check("explicit runtime cannot lower the 1792 startup line", () => {
      int startup = 1792, runtime = PdfMemoryPolicy.RuntimeLimit(startup, 1024);
      Eq(1024, runtime, "runtime");
      Eq(true, PdfMemoryPolicy.Below(1700 * MiB, startup), "startup still rejects 1700");
      Eq(false, PdfMemoryPolicy.Below(1700 * MiB, runtime), "runtime alone would admit 1700");
    });

    Check("old 3072 and new 1792 disagree at 2000 MiB", () => {
      Eq(true, PdfMemoryPolicy.Below(2000 * MiB, 3072), "old rejects");
      Eq(false, PdfMemoryPolicy.Below(2000 * MiB, 1792), "new admits");
    });

    Check("runtime below 1024 MiB is rejected", () => {
      Throws(() => PdfMemoryPolicy.RuntimeLimit(1792, 1023), "at least 1024 MiB");
    });

    Check("runtime above the startup line is rejected", () => {
      Throws(() => PdfMemoryPolicy.RuntimeLimit(1792, 1793), "must not be below");
    });

    Check("startup below 512 MiB is rejected", () => {
      Throws(() => PdfMemoryPolicy.RuntimeLimit(511, 0), "explicit bounded memory thresholds");
    });

    Check("Below is strict at the startup line", () => {
      Eq(false, PdfMemoryPolicy.Below(1792 * MiB, 1792), "equality");
      Eq(true, PdfMemoryPolicy.Below(1792 * MiB - 1, 1792), "one byte below");
    });

    Console.WriteLine("1.." + (passed + failed));
    Console.WriteLine("# passed " + passed + " failed " + failed);
    return failed == 0 ? 0 : 1;
  }
}
