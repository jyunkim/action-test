const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_COMMENT_LENGTH,
  SUMMARY_MARKER,
  fingerprint,
  parsePatch,
  partitionFindings,
  publishCodexReview,
  renderSummary,
} = require("./publish-codex-review");

const finding = {
  severity: "major",
  title: "상태 갱신이 누락됩니다",
  body: "실패 경로에서 상태가 갱신되지 않아 재처리됩니다.",
  path: "src/order.js",
  line: 12,
  side: "RIGHT",
};

test("parsePatch maps LEFT and RIGHT lines", () => {
  const patch = [
    "@@ -10,3 +10,4 @@",
    " context",
    "-old value",
    "+new value",
    "+added value",
    " context",
  ].join("\n");

  assert.deepEqual(
    [...parsePatch(patch)].sort(),
    [
      "LEFT:10",
      "LEFT:11",
      "LEFT:12",
      "RIGHT:10",
      "RIGHT:11",
      "RIGHT:12",
      "RIGHT:13",
    ],
  );
});

test("fingerprint is stable when only the line moves", () => {
  assert.equal(fingerprint(finding), fingerprint({ ...finding, line: 99 }));
  assert.notEqual(fingerprint(finding), fingerprint({ ...finding, body: "다른 문제" }));
});

test("partitionFindings separates inline, duplicate, and unanchored findings", () => {
  const duplicate = { ...finding, title: "중복 문제", line: 13 };
  const marker = `<!-- codex-pr-review-fingerprint:${fingerprint(duplicate)} -->`;
  const result = partitionFindings(
    [finding, duplicate, { ...finding, title: "위치 없음", line: 99 }],
    [
      {
        filename: "src/order.js",
        patch: "@@ -10,1 +10,4 @@\n context\n+one\n+two\n+three",
      },
    ],
    [{ body: marker }],
  );

  assert.deepEqual(result.inline.map(({ title }) => title), [finding.title]);
  assert.deepEqual(result.duplicates.map(({ title }) => title), [duplicate.title]);
  assert.deepEqual(result.unanchored.map(({ title }) => title), ["위치 없음"]);
});

test("renderSummary renders the sticky marker and fallback section", () => {
  const body = renderSummary(
    {
      summary: "한 가지 회귀가 있습니다.",
      positive_changes: ["검증 책임이 분리되었습니다."],
      findings: [finding],
    },
    "abcdef1234567890",
    [finding],
  );

  assert.match(body, new RegExp(SUMMARY_MARKER));
  assert.match(body, /abcdef1/);
  assert.match(body, /검증 책임이 분리되었습니다/);
  assert.match(body, /인라인 위치를 확인하지 못한 지적/);
});

function githubMock({ existingSummary, reviewError } = {}) {
  const calls = {
    createComment: [],
    createReview: [],
    updateComment: [],
  };
  const endpoints = {
    listComments: Symbol("listComments"),
    listFiles: Symbol("listFiles"),
    listReviewComments: Symbol("listReviewComments"),
  };
  const github = {
    paginate: async (endpoint) => {
      if (endpoint === endpoints.listFiles) {
        return [
          {
            filename: "src/order.js",
            patch: "@@ -10,1 +10,3 @@\n context\n+one\n+two",
          },
        ];
      }
      if (endpoint === endpoints.listReviewComments) {
        return [];
      }
      return existingSummary ? [existingSummary] : [];
    },
    rest: {
      issues: {
        createComment: async (input) => calls.createComment.push(input),
        listComments: endpoints.listComments,
        updateComment: async (input) => calls.updateComment.push(input),
      },
      pulls: {
        createReview: async (input) => {
          calls.createReview.push(input);
          if (reviewError) {
            throw reviewError;
          }
        },
        listFiles: endpoints.listFiles,
        listReviewComments: endpoints.listReviewComments,
      },
    },
  };

  return { calls, github };
}

const context = {
  repo: { owner: "LCP", repo: "lcp-order" },
  payload: {
    pull_request: {
      number: 42,
      head: { sha: "abcdef1234567890" },
    },
  },
};

test("publishCodexReview creates an advisory inline review and summary", async () => {
  const { calls, github } = githubMock();

  await publishCodexReview({
    github,
    context,
    core: { info() {} },
    resultJson: JSON.stringify({
      summary: "요약",
      positive_changes: [],
      findings: [finding],
    }),
  });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].event, "COMMENT");
  assert.equal(calls.createReview[0].comments[0].path, finding.path);
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /Codex 자동 리뷰/);
});

test("publishCodexReview updates an existing bot summary", async () => {
  const existingSummary = {
    id: 123,
    body: `${SUMMARY_MARKER}\nold`,
    user: { type: "Bot" },
  };
  const { calls, github } = githubMock({ existingSummary });

  await publishCodexReview({
    github,
    context,
    core: { info() {} },
    resultJson: JSON.stringify({
      summary: "새 요약",
      positive_changes: [],
      findings: [],
    }),
  });

  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.updateComment.length, 1);
  assert.equal(calls.updateComment[0].comment_id, 123);
  assert.match(calls.updateComment[0].body, /새 요약/);
});

test("publishCodexReview falls back to the summary for rejected inline locations", async () => {
  const reviewError = Object.assign(new Error("invalid line"), { status: 422 });
  const { calls, github } = githubMock({ reviewError });

  await publishCodexReview({
    github,
    context,
    core: { info() {} },
    resultJson: JSON.stringify({
      summary: "요약",
      positive_changes: [],
      findings: [finding],
    }),
  });

  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /인라인 위치를 확인하지 못한 지적/);
});

test("publishCodexReview rethrows non-validation review errors", async () => {
  const reviewError = Object.assign(new Error("service unavailable"), { status: 503 });
  const { github } = githubMock({ reviewError });

  await assert.rejects(
    publishCodexReview({
      github,
      context,
      core: { info() {} },
      resultJson: JSON.stringify({
        summary: "요약",
        positive_changes: [],
        findings: [finding],
      }),
    }),
    /service unavailable/,
  );
});

test("workflow starts Codex outside the untrusted pull request checkout", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../workflows/codex-pr-review.yml"),
    "utf8",
  );

  assert.match(workflow, /path: trusted-base\/review-target/);
  assert.match(workflow, /working-directory: \$\{\{ github\.workspace \}\}\/trusted-base$/m);
  assert.match(workflow, /git -C review-target diff/);
  assert.doesNotMatch(
    workflow,
    /working-directory: \$\{\{ github\.workspace \}\}\/review-target/,
  );
});

test("renderSummary bounds the largest schema-valid review", () => {
  const largestFinding = {
    severity: "major",
    title: "제목".repeat(100),
    body: "본문".repeat(1000),
    path: "path/" + "a".repeat(995),
    line: 1,
    side: "RIGHT",
  };
  const review = {
    summary: "요약".repeat(2000),
    positive_changes: Array.from({ length: 10 }, () => "장점".repeat(250)),
    findings: Array.from({ length: 20 }, () => largestFinding),
  };

  const body = renderSummary(review, "abcdef1234567890", review.findings);

  assert.ok(body.length <= MAX_COMMENT_LENGTH);
  assert.match(body, /GitHub 댓글 길이 제한으로 일부 내용이 생략되었습니다/);
});
