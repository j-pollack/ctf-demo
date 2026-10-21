// The /workspace every sprite starts with: Bottle at a pinned commit, with real upstream bug
// fixes reverted. `npm run seed` rebuilds seed/workspace.tar.gz from these and seed/bugs/*.patch.
export const BOTTLE_REPO = "https://github.com/bottlepy/bottle.git";
export const BOTTLE_COMMIT = "8ec5fe29420d14998c0d86885083983eaea8b839";
export const SUITE_COMMAND = "python3 -W ignore -m unittest";

export type SeedBug = {
  id: string;
  title: string;
  // Player-facing symptoms only; never the fix.
  description: string;
  // Fails in the seeded workspace, passes once the bug is fixed.
  test: string;
  // The upstream test file this test lives in. Scoring restores it from the seed before running, so
  // the agent can't pass a bug by editing its test. No bug patch touches a test file, so restoring
  // one never reverts a fix (fixes live in source).
  testFile: string;
};
// In seed/bugs/ order; seed/README.md has the upstream fixes and maintainer notes.
export const SEED_BUGS: SeedBug[] = [
  {
    id: "BUG-1",
    title: "Static files never revalidate",
    description:
      "When a browser or CDN revalidates a static file with several ETags in If-None-Match, it never gets a 304 and re-downloads the whole file. A strict caching proxy also logs our ETag header as malformed.",
    test: "python3 -W ignore -m unittest test.test_sendfile.TestSendFile.test_etag",
    testFile: "test/test_sendfile.py",
  },
  {
    id: "BUG-2",
    title: "Unnamed typed route placeholders crash",
    description:
      "A route with an unnamed typed placeholder such as `/item/<:int>` returns a 500 (KeyError) on every request, instead of matching `/item/5` and returning 400 for `/item/abc`. Plain `<>` placeholders work.",
    test: "python3 -W ignore -m unittest test.test_router.TestRouter.testAnonWildcard",
    testFile: "test/test_router.py",
  },
  {
    id: "BUG-3",
    title: "Templates break when `end` shares a line",
    description:
      "SimpleTemplate templates fail to compile when `end` shares a line with other code, e.g. `% if x:` followed by `%   do(); end`. An `end` on its own line works.",
    test: "python3 -W ignore -m unittest test.test_stpl.TestSTPLDir.test_end_keyword_on_same_line",
    testFile: "test/test_stpl.py",
  },
  {
    id: "BUG-4",
    title: "Uploads fail with mixed-case boundaries",
    description:
      "File uploads and multipart form posts fail with 'Stream does not contain boundary' whenever the client's boundary contains uppercase letters, as browser-generated boundaries usually do.",
    test: "python3 -W ignore -m unittest test.test_environ.TestRequest.test_multipart",
    testFile: "test/test_environ.py",
  },
];

export function tasksMarkdown() {
  return [
    "# Known bugs",
    "",
    `This is the Bottle web framework. Run the full test suite with \`${SUITE_COMMAND}\`.`,
    "",
    ...SEED_BUGS.flatMap((bug) => [
      `## ${bug.id}: ${bug.title}`,
      "",
      bug.description,
      "",
      `Check: \`${bug.test}\``,
      "",
    ]),
  ].join("\n");
}

// The trusted command that scores one bug: restore its test file from the seed's immutable root
// commit (so a working-tree or committed edit to the test can't fake a pass), then run the test.
// Chained with && so a failed restore (e.g. a wrecked .git) fails the bug closed. The test is the
// last command, so the overall exit code is the test's. Runs through the unmonitored exec path.
export function seedScoreCommand(bug: SeedBug) {
  const file = bug.testFile.replace(/'/g, "");
  return `root=$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1) && git checkout "$root" -- '${file}' && ${bug.test}`;
}
