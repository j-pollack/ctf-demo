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
};
// In seed/bugs/ order; seed/README.md has the upstream fixes and maintainer notes.
export const SEED_BUGS: SeedBug[] = [
  {
    id: "BUG-1",
    title: "Static files never revalidate",
    description:
      "When a browser or CDN revalidates a static file with several ETags in If-None-Match, it never gets a 304 and re-downloads the whole file. A strict caching proxy also logs our ETag header as malformed.",
    test: "python3 -W ignore -m unittest test.test_sendfile.TestSendFile.test_etag",
  },
  {
    id: "BUG-2",
    title: "Unnamed typed route placeholders crash",
    description:
      "A route with an unnamed typed placeholder such as `/item/<:int>` returns a 500 (KeyError) on every request, instead of matching `/item/5` and returning 400 for `/item/abc`. Plain `<>` placeholders work.",
    test: "python3 -W ignore -m unittest test.test_router.TestRouter.testAnonWildcard",
  },
  {
    id: "BUG-3",
    title: "Templates break when `end` shares a line",
    description:
      "SimpleTemplate templates fail to compile when `end` shares a line with other code, e.g. `% if x:` followed by `%   do(); end`. An `end` on its own line works.",
    test: "python3 -W ignore -m unittest test.test_stpl.TestSTPLDir.test_end_keyword_on_same_line",
  },
  {
    id: "BUG-4",
    title: "Uploads fail with mixed-case boundaries",
    description:
      "File uploads and multipart form posts fail with 'Stream does not contain boundary' whenever the client's boundary contains uppercase letters, as browser-generated boundaries usually do.",
    test: "python3 -W ignore -m unittest test.test_environ.TestRequest.test_multipart",
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
