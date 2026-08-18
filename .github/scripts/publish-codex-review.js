const crypto = require("node:crypto");

const MAX_COMMENT_LENGTH = 60_000;
const SUMMARY_MARKER = "<!-- codex-pr-review -->";
const FINGERPRINT_PREFIX = "<!-- codex-pr-review-fingerprint:";
const SEVERITY_LABELS = {
  critical: "CRITICAL",
  major: "MAJOR",
  minor: "MINOR",
  suggestion: "SUGGESTION",
};

function parsePatch(patch) {
  const commentableLines = new Set();
  if (!patch) {
    return commentableLines;
  }

  let leftLine = 0;
  let rightLine = 0;

  for (const patchLine of patch.split("\n")) {
    const header = patchLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      leftLine = Number(header[1]);
      rightLine = Number(header[2]);
      continue;
    }
    if (patchLine.startsWith("+") && !patchLine.startsWith("+++")) {
      commentableLines.add(`RIGHT:${rightLine}`);
      rightLine += 1;
      continue;
    }
    if (patchLine.startsWith("-") && !patchLine.startsWith("---")) {
      commentableLines.add(`LEFT:${leftLine}`);
      leftLine += 1;
      continue;
    }
    if (patchLine.startsWith(" ")) {
      commentableLines.add(`LEFT:${leftLine}`);
      commentableLines.add(`RIGHT:${rightLine}`);
      leftLine += 1;
      rightLine += 1;
    }
  }

  return commentableLines;
}

function fingerprint(finding) {
  const semanticFinding = {
    severity: finding.severity,
    path: finding.path,
    title: finding.title,
    body: finding.body,
  };

  return crypto.createHash("sha256").update(JSON.stringify(semanticFinding)).digest("hex");
}

function inlineCommentBody(finding) {
  return [
    `**[${SEVERITY_LABELS[finding.severity]}] ${finding.title}**`,
    "",
    finding.body,
    "",
    `${FINGERPRINT_PREFIX}${fingerprint(finding)} -->`,
  ].join("\n");
}

function partitionFindings(findings, files, existingComments) {
  const linesByPath = new Map(files.map((file) => [file.filename, parsePatch(file.patch)]));
  const existingBodies = existingComments.map((comment) => comment.body || "");
  const result = { inline: [], duplicates: [], unanchored: [] };

  for (const finding of findings) {
    const marker = `${FINGERPRINT_PREFIX}${fingerprint(finding)} -->`;
    if (existingBodies.some((body) => body.includes(marker))) {
      result.duplicates.push(finding);
      continue;
    }

    const commentableLines = linesByPath.get(finding.path);
    if (!commentableLines || !commentableLines.has(`${finding.side}:${finding.line}`)) {
      result.unanchored.push(finding);
      continue;
    }

    result.inline.push(finding);
  }

  return result;
}

function renderFinding(finding) {
  return [
    `- **[${SEVERITY_LABELS[finding.severity]}] ${finding.title}** — `
      + `\`${finding.path}:${finding.line}\` (${finding.side})`,
    `  ${finding.body}`,
  ].join("\n");
}

function boundCommentBody(body) {
  if (body.length <= MAX_COMMENT_LENGTH) {
    return body;
  }

  const suffix = "\n\n> GitHub 댓글 길이 제한으로 일부 내용이 생략되었습니다.";
  return body.slice(0, MAX_COMMENT_LENGTH - suffix.length) + suffix;
}

function renderSummary(review, headSha, unanchored) {
  const sections = [
    SUMMARY_MARKER,
    "## Codex 자동 리뷰",
    "",
    `검토 커밋: \`${headSha.slice(0, 7)}\``,
    "",
    review.summary,
  ];

  if (review.positive_changes.length > 0) {
    sections.push(
      "",
      "### 긍정적인 변경",
      "",
      ...review.positive_changes.map((item) => `- ${item}`),
    );
  }

  sections.push(
    "",
    "### 발견 사항",
    "",
    ...(review.findings.length > 0
      ? review.findings.map(renderFinding)
      : ["발견된 문제가 없습니다."]),
  );

  if (unanchored.length > 0) {
    sections.push(
      "",
      "### 인라인 위치를 확인하지 못한 지적",
      "",
      ...unanchored.map(renderFinding),
    );
  }

  return boundCommentBody(sections.join("\n"));
}

async function publishCodexReview({ github, context, core, resultJson }) {
  const review = JSON.parse(resultJson);
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = context.payload.pull_request.number;
  const headSha = context.payload.pull_request.head.sha;
  const pullRequest = {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  };

  const [files, existingReviewComments, issueComments] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, pullRequest),
    github.paginate(github.rest.pulls.listReviewComments, pullRequest),
    github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    }),
  ]);

  const partitioned = partitionFindings(review.findings, files, existingReviewComments);
  const inlineComments = partitioned.inline.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: finding.side,
    body: inlineCommentBody(finding),
  }));

  if (inlineComments.length > 0) {
    try {
      await github.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: headSha,
        event: "COMMENT",
        body: "Codex 자동 리뷰에서 새로운 인라인 지적을 남겼습니다.",
        comments: inlineComments,
      });
    } catch (error) {
      if (error.status !== 422) {
        throw error;
      }
      partitioned.unanchored.push(...partitioned.inline);
      core.info("GitHub에서 인라인 위치를 거부하여 종합 댓글에만 포함합니다.");
    }
  }

  const summaryBody = renderSummary(review, headSha, partitioned.unanchored);
  const existingSummary = issueComments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(SUMMARY_MARKER),
  );

  if (existingSummary) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingSummary.id,
      body: summaryBody,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: summaryBody,
    });
  }

  core.info(
    `Codex review published: ${partitioned.inline.length} inline, `
      + `${partitioned.duplicates.length} duplicate, `
      + `${partitioned.unanchored.length} unanchored`,
  );
}

module.exports = {
  MAX_COMMENT_LENGTH,
  SUMMARY_MARKER,
  fingerprint,
  inlineCommentBody,
  parsePatch,
  partitionFindings,
  publishCodexReview,
  renderSummary,
};
