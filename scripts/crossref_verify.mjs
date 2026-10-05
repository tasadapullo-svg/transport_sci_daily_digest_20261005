import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const AUDIT_DIR = path.join(ROOT_DIR, "audit");
const BASELINE_DATE = "20261005";
const SOURCE_BASELINE = path.join(AUDIT_DIR, `openalex_baseline_v11_${BASELINE_DATE}.json`);
const OUTPUT_JSON = path.join(AUDIT_DIR, `crossref_verification_${BASELINE_DATE}.json`);
const OUTPUT_CSV = path.join(AUDIT_DIR, `crossref_verification_${BASELINE_DATE}.csv`);
const OUTPUT_MD = path.join(AUDIT_DIR, `crossref_verification_${BASELINE_DATE}.md`);
const CROSSREF_WORKS_URL = "https://api.crossref.org/works";
const USER_AGENT = "transport-sci-daily-digest/1.0";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const VERIFIED_STATUSES = new Set(["VERIFIED", "VERIFIED_WITH_VARIATION"]);

const TITLE_MINOR_THRESHOLD = 0.8;
const TITLE_MATCH_THRESHOLD = 0.95;

const JOURNAL_VARIATION_STOPWORDS = new Set([
  "and",
  "the",
  "part",
  "a",
  "b",
  "c",
  "d",
  "e",
  "emerging",
  "technologies",
  "methodological",
  "policy",
  "practice",
  "transport",
  "environment",
  "logistics",
  "review",
  "systems",
  "science",
  "dynamics"
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeDoi(doi) {
  if (!doi) return "";
  return String(doi)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//, "")
    .replace(/^http:\/\/dx\.doi\.org\//, "")
    .replace(/^https:\/\/dx\.doi\.org\//, "")
    .trim();
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanMetadataString(value) {
  return stripHtml(value).replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanMetadataString(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleForComparison(value) {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeJournal(value) {
  return normalizeText(value)
    .replace(/\s*&\s*/g, " and ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function simplifyJournal(value) {
  return normalizeJournal(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\bpart\s+([abcde])\b/gu, "part$1")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(value) {
  return normalizeTitleForComparison(value)
    .split(" ")
    .filter((token) => token.length > 0);
}

function tokenJaccard(left, right) {
  const leftTokens = new Set(titleTokens(left));
  const rightTokens = new Set(titleTokens(right));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function compareTitles(openalexTitle, crossrefTitle) {
  if (!crossrefTitle) {
    return {
      title_similarity: 0,
      title_status: "TITLE_MISSING"
    };
  }

  const openalexNormalized = normalizeTitleForComparison(openalexTitle);
  const crossrefNormalized = normalizeTitleForComparison(crossrefTitle);
  const titleSimilarity = openalexNormalized === crossrefNormalized ? 1 : tokenJaccard(openalexTitle, crossrefTitle);

  let titleStatus = "TITLE_MISMATCH";
  if (titleSimilarity >= TITLE_MATCH_THRESHOLD) titleStatus = "TITLE_MATCH";
  else if (titleSimilarity >= TITLE_MINOR_THRESHOLD) titleStatus = "TITLE_MINOR_VARIATION";

  return {
    title_similarity: Number(titleSimilarity.toFixed(4)),
    title_status: titleStatus
  };
}

function journalTokens(value) {
  return simplifyJournal(value)
    .split(" ")
    .filter((token) => token && !JOURNAL_VARIATION_STOPWORDS.has(token));
}

function compareJournals(openalexJournal, crossrefJournal) {
  if (!crossrefJournal) return "MISSING";

  const openalexNormalized = normalizeJournal(openalexJournal);
  const crossrefNormalized = normalizeJournal(crossrefJournal);
  if (openalexNormalized === crossrefNormalized) return "MATCH";

  const openalexSimplified = simplifyJournal(openalexJournal);
  const crossrefSimplified = simplifyJournal(crossrefJournal);
  if (openalexSimplified === crossrefSimplified) return "MINOR_VARIATION";

  if (openalexSimplified.includes(crossrefSimplified) || crossrefSimplified.includes(openalexSimplified)) {
    return "MINOR_VARIATION";
  }

  const openalexTokens = new Set(journalTokens(openalexJournal));
  const crossrefTokens = new Set(journalTokens(crossrefJournal));
  if (openalexTokens.size > 0 && crossrefTokens.size > 0) {
    let intersection = 0;
    for (const token of openalexTokens) {
      if (crossrefTokens.has(token)) intersection += 1;
    }
    const union = new Set([...openalexTokens, ...crossrefTokens]).size;
    if (intersection / union >= 0.75) return "MINOR_VARIATION";
  }

  return "MISMATCH";
}

function firstArrayValue(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function extractDateFromParts(dateObject) {
  const parts = dateObject?.["date-parts"]?.[0];
  if (!Array.isArray(parts) || parts.length === 0 || !parts[0]) return "";
  const year = String(parts[0]).padStart(4, "0");
  const month = String(parts[1] ?? 1).padStart(2, "0");
  const day = String(parts[2] ?? 1).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function crossrefPublicationDate(message) {
  const sources = ["published-online", "published-print", "published", "issued"];
  for (const source of sources) {
    const parsed = extractDateFromParts(message?.[source]);
    if (parsed) {
      return {
        crossref_publication_date: parsed,
        crossref_date_source: source
      };
    }
  }
  return {
    crossref_publication_date: "",
    crossref_date_source: ""
  };
}

function dateDifferenceDays(leftDate, rightDate) {
  if (!leftDate || !rightDate) return null;
  const left = new Date(`${leftDate}T00:00:00Z`);
  const right = new Date(`${rightDate}T00:00:00Z`);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return null;
  return Math.abs(Math.round((left.getTime() - right.getTime()) / 86400000));
}

function dateStatus(openalexDate, crossrefDate) {
  const difference = dateDifferenceDays(openalexDate, crossrefDate);
  if (difference === null) return { date_difference_days: null, date_status: "DATE_MISSING" };
  if (difference <= 7) return { date_difference_days: difference, date_status: "DATE_MATCH" };
  if (difference <= 31) return { date_difference_days: difference, date_status: "DATE_MINOR_VARIATION" };
  return { date_difference_days: difference, date_status: "DATE_REVIEW" };
}

function buildCrossrefUrl(doi) {
  const url = new URL(`${CROSSREF_WORKS_URL}/${encodeURIComponent(doi)}`);
  if (process.env.CROSSREF_MAILTO) url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
  return url.toString();
}

async function fetchCrossrefWork(doi) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(buildCrossrefUrl(doi), {
        headers: {
          "User-Agent": USER_AGENT
        }
      });

      if (response.status === 404) {
        return {
          found: false,
          status: 404,
          error: "CROSSREF_NOT_FOUND"
        };
      }

      if (RETRY_STATUSES.has(response.status)) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`);
      }

      if (!response.ok) {
        const body = await response.text();
        return {
          found: false,
          status: response.status,
          error: `HTTP ${response.status}: ${body.slice(0, 240)}`
        };
      }

      const payload = await response.json();
      return {
        found: true,
        status: response.status,
        message: payload.message ?? {}
      };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(1000 * 2 ** (attempt - 1));
    }
  }

  return {
    found: false,
    status: null,
    error: lastError?.message ?? "UNKNOWN_ERROR"
  };
}

function makeReviewResult(work, verificationStatus, reason) {
  return {
    openalex_id: work.openalex_id,
    openalex_doi: normalizeDoi(work.doi),
    crossref_doi: "",
    doi_match: "NOT_FOUND",
    openalex_title: work.title,
    crossref_title: "",
    title_similarity: 0,
    title_status: "TITLE_MISSING",
    openalex_journal: work.journal,
    crossref_journal: "",
    journal_match: "MISSING",
    openalex_publication_date: work.publication_date,
    crossref_publication_date: "",
    crossref_date_source: "",
    date_difference_days: null,
    date_status: "DATE_MISSING",
    publisher: "",
    type: "",
    issn: [],
    issn_type: [],
    authors_count: 0,
    url: "",
    member: "",
    prefix: "",
    license: [],
    subject: [],
    reference_count: null,
    is_referenced_by_count: null,
    oa_status: work.oa_status,
    relevance_class: work.relevance_class,
    score: work.score,
    query_ids: work.query_ids,
    verification_status: verificationStatus,
    review_reasons: [reason]
  };
}

function determineVerificationStatus(fields) {
  const reviewReasons = [];
  if (fields.doi_match === "MISMATCH") reviewReasons.push("DOI_MISMATCH");
  if (fields.title_status === "TITLE_MISMATCH") reviewReasons.push("TITLE_MISMATCH");
  if (fields.title_status === "TITLE_MISSING") reviewReasons.push("TITLE_MISSING");
  if (fields.journal_match === "MISMATCH") reviewReasons.push("JOURNAL_MISMATCH");
  if (fields.journal_match === "MISSING") reviewReasons.push("JOURNAL_MISSING");
  if (fields.type && fields.type !== "journal-article") reviewReasons.push("TYPE_REVIEW");

  if (reviewReasons.length > 0) {
    return {
      verification_status: "REVIEW_REQUIRED",
      review_reasons: reviewReasons
    };
  }

  const variationReasons = [];
  if (fields.title_status === "TITLE_MINOR_VARIATION") variationReasons.push("TITLE_MINOR_VARIATION");
  if (fields.journal_match === "MINOR_VARIATION") variationReasons.push("JOURNAL_MINOR_VARIATION");
  if (fields.date_status === "DATE_REVIEW") variationReasons.push("DATE_REVIEW");
  if (fields.date_status === "DATE_MISSING") variationReasons.push("DATE_MISSING");
  if (!fields.type) variationReasons.push("TYPE_MISSING");

  if (variationReasons.length > 0) {
    return {
      verification_status: "VERIFIED_WITH_VARIATION",
      review_reasons: variationReasons
    };
  }

  return {
    verification_status: "VERIFIED",
    review_reasons: []
  };
}

function verifyFoundWork(work, message) {
  const crossrefDoi = normalizeDoi(message.DOI);
  const openalexDoi = normalizeDoi(work.doi);
  const crossrefTitle = cleanMetadataString(firstArrayValue(message.title));
  const crossrefJournal = cleanMetadataString(firstArrayValue(message["container-title"]));
  const titleComparison = compareTitles(work.title, crossrefTitle);
  const journalMatch = compareJournals(work.journal, crossrefJournal);
  const publication = crossrefPublicationDate(message);
  const dateComparison = dateStatus(work.publication_date, publication.crossref_publication_date);

  const fields = {
    openalex_id: work.openalex_id,
    openalex_doi: openalexDoi,
    crossref_doi: crossrefDoi,
    doi_match: openalexDoi && crossrefDoi && openalexDoi === crossrefDoi ? "MATCH" : "MISMATCH",
    openalex_title: work.title,
    crossref_title: crossrefTitle,
    title_similarity: titleComparison.title_similarity,
    title_status: titleComparison.title_status,
    openalex_journal: work.journal,
    crossref_journal: crossrefJournal,
    journal_match: journalMatch,
    openalex_publication_date: work.publication_date,
    crossref_publication_date: publication.crossref_publication_date,
    crossref_date_source: publication.crossref_date_source,
    date_difference_days: dateComparison.date_difference_days,
    date_status: dateComparison.date_status,
    publisher: message.publisher ?? "",
    type: message.type ?? "",
    issn: message.ISSN ?? [],
    issn_type: message["ISSN-type"] ?? [],
    authors_count: Array.isArray(message.author) ? message.author.length : 0,
    url: message.URL ?? "",
    member: message.member ?? "",
    prefix: message.prefix ?? "",
    license: message.license ?? [],
    subject: message.subject ?? [],
    reference_count: message["reference-count"] ?? null,
    is_referenced_by_count: message["is-referenced-by-count"] ?? null,
    oa_status: work.oa_status,
    relevance_class: work.relevance_class,
    score: work.score,
    query_ids: work.query_ids
  };

  const status = determineVerificationStatus(fields);
  return {
    ...fields,
    verification_status: status.verification_status,
    review_reasons: status.review_reasons
  };
}

function csvEscape(value) {
  const stringValue = Array.isArray(value) ? value.join(";") : String(value ?? "");
  if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replaceAll('"', '""')}"`;
  return stringValue;
}

function makeCsv(works) {
  const columns = [
    "rank",
    "verification_status",
    "relevance_class",
    "score",
    "openalex_doi",
    "crossref_doi",
    "doi_match",
    "openalex_title",
    "crossref_title",
    "title_similarity",
    "title_status",
    "openalex_journal",
    "crossref_journal",
    "journal_match",
    "openalex_publication_date",
    "crossref_publication_date",
    "date_difference_days",
    "date_status",
    "publisher",
    "type",
    "issn",
    "authors_count",
    "query_ids",
    "review_reasons"
  ];

  const rows = works.map((work, index) => ({
    rank: index + 1,
    verification_status: work.verification_status,
    relevance_class: work.relevance_class,
    score: work.score,
    openalex_doi: work.openalex_doi,
    crossref_doi: work.crossref_doi,
    doi_match: work.doi_match,
    openalex_title: work.openalex_title,
    crossref_title: work.crossref_title,
    title_similarity: work.title_similarity,
    title_status: work.title_status,
    openalex_journal: work.openalex_journal,
    crossref_journal: work.crossref_journal,
    journal_match: work.journal_match,
    openalex_publication_date: work.openalex_publication_date,
    crossref_publication_date: work.crossref_publication_date,
    date_difference_days: work.date_difference_days,
    date_status: work.date_status,
    publisher: work.publisher,
    type: work.type,
    issn: work.issn,
    authors_count: work.authors_count,
    query_ids: work.query_ids,
    review_reasons: work.review_reasons
  }));

  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\n");
}

function countBy(works, key) {
  const counts = {};
  for (const work of works) {
    const value = work[key] || "MISSING";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function tableRow(values) {
  return `| ${values.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ")} |`;
}

function makeMarkdown(audit) {
  const counts = audit.counts;
  const typeCounts = countBy(audit.works, "type");
  const aCore = audit.works.filter((work) => work.relevance_class === "A_CORE");
  const top10Ids = new Set(audit.simulated_top10_crossref_status.map((work) => work.openalex_id));
  const top10Rows = audit.works.filter((work) => top10Ids.has(work.openalex_id));

  const lines = [];
  lines.push("# Crossref DOI Metadata Verification v1.0");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total: ${audit.total_works}`);
  lines.push(`- Found: ${audit.crossref_found}`);
  lines.push(`- Not found: ${audit.crossref_not_found}`);
  lines.push(`- Verified: ${audit.verified}`);
  lines.push(`- Verified with variation: ${audit.verified_with_variation}`);
  lines.push(`- Review required: ${audit.review_required}`);
  lines.push(`- Errors: ${audit.errors}`);
  lines.push("");
  lines.push("## DOI Verification");
  lines.push("");
  lines.push(`- DOI MATCH: ${counts.doi_match.MATCH ?? 0}`);
  lines.push(`- DOI MISMATCH: ${counts.doi_match.MISMATCH ?? 0}`);
  lines.push("");
  lines.push("## Title Verification");
  lines.push("");
  lines.push(`- Exact/high match: ${counts.title_status.TITLE_MATCH ?? 0}`);
  lines.push(`- Minor variation: ${counts.title_status.TITLE_MINOR_VARIATION ?? 0}`);
  lines.push(`- Mismatch: ${counts.title_status.TITLE_MISMATCH ?? 0}`);
  lines.push(`- Missing: ${counts.title_status.TITLE_MISSING ?? 0}`);
  lines.push("");
  lines.push("## Journal Verification");
  lines.push("");
  lines.push(`- Match: ${counts.journal_match.MATCH ?? 0}`);
  lines.push(`- Minor variation: ${counts.journal_match.MINOR_VARIATION ?? 0}`);
  lines.push(`- Mismatch: ${counts.journal_match.MISMATCH ?? 0}`);
  lines.push(`- Missing: ${counts.journal_match.MISSING ?? 0}`);
  lines.push("");
  lines.push("## Date Verification");
  lines.push("");
  lines.push(`- Match: ${counts.date_status.DATE_MATCH ?? 0}`);
  lines.push(`- Minor variation: ${counts.date_status.DATE_MINOR_VARIATION ?? 0}`);
  lines.push(`- Review: ${counts.date_status.DATE_REVIEW ?? 0}`);
  lines.push(`- Missing: ${counts.date_status.DATE_MISSING ?? 0}`);
  lines.push("");
  lines.push("## Type Verification");
  lines.push("");
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push("");
  lines.push("## Review Required Papers");
  lines.push("");
  const reviewPapers = audit.works.filter((work) => work.verification_status === "REVIEW_REQUIRED");
  if (reviewPapers.length === 0) {
    lines.push("None.");
  } else {
    lines.push(tableRow(["DOI", "OpenAlex title", "Crossref title", "OpenAlex journal", "Crossref journal", "reason"]));
    lines.push(tableRow(["---", "---", "---", "---", "---", "---"]));
    for (const work of reviewPapers) {
      lines.push(tableRow([work.openalex_doi, work.openalex_title, work.crossref_title, work.openalex_journal, work.crossref_journal, work.review_reasons.join(";")]));
    }
  }
  lines.push("");
  lines.push("## Crossref Not Found");
  lines.push("");
  const notFound = audit.works.filter((work) => work.verification_status === "CROSSREF_NOT_FOUND");
  if (notFound.length === 0) {
    lines.push("None.");
  } else {
    lines.push(tableRow(["DOI", "OpenAlex title", "OpenAlex journal"]));
    lines.push(tableRow(["---", "---", "---"]));
    for (const work of notFound) {
      lines.push(tableRow([work.openalex_doi, work.openalex_title, work.openalex_journal]));
    }
  }
  lines.push("");
  lines.push("## A_CORE Verification");
  lines.push("");
  lines.push(`- A_CORE total: ${aCore.length}`);
  lines.push(`- A_CORE verified: ${aCore.filter((work) => work.verification_status === "VERIFIED").length}`);
  lines.push(`- A_CORE verified_with_variation: ${aCore.filter((work) => work.verification_status === "VERIFIED_WITH_VARIATION").length}`);
  lines.push(`- A_CORE review_required: ${aCore.filter((work) => work.verification_status === "REVIEW_REQUIRED").length}`);
  lines.push(`- A_CORE not_found: ${aCore.filter((work) => work.verification_status === "CROSSREF_NOT_FOUND").length}`);
  lines.push("");
  lines.push("## Simulated Daily Top 10 Crossref Status");
  lines.push("");
  lines.push(tableRow(["rank", "status", "DOI", "title", "journal"]));
  lines.push(tableRow(["---:", "---", "---", "---", "---"]));
  for (const item of audit.simulated_top10_crossref_status) {
    const work = top10Rows.find((row) => row.openalex_id === item.openalex_id);
    lines.push(tableRow([item.rank, item.verification_status, work?.openalex_doi ?? "", work?.openalex_title ?? item.title, work?.openalex_journal ?? ""]));
  }
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(`- Status: ${audit.validation.status}`);
  for (const check of audit.validation.checks) {
    lines.push(`- ${check.name}: ${check.status}${check.details ? ` - ${check.details}` : ""}`);
  }

  return `${lines.join("\n")}\n`;
}

function makeValidation(audit) {
  const checks = [];
  const works = audit.works;
  const total = works.length;
  const verifiedOrVariation = works.filter((work) => VERIFIED_STATUSES.has(work.verification_status)).length;
  const aCore = works.filter((work) => work.relevance_class === "A_CORE");
  const aCoreVerifiedOrVariation = aCore.filter((work) => VERIFIED_STATUSES.has(work.verification_status)).length;
  const top10Verified = audit.simulated_top10_crossref_status.filter((work) => VERIFIED_STATUSES.has(work.verification_status)).length;

  checks.push({
    name: "all_works_processed",
    status: total === audit.total_works && total === 169 ? "PASS" : "FAIL",
    details: `${total}/${audit.total_works}`
  });

  const doiCounts = new Map();
  for (const work of works) {
    if (!work.openalex_doi) continue;
    doiCounts.set(work.openalex_doi, (doiCounts.get(work.openalex_doi) ?? 0) + 1);
  }
  const duplicateDois = [...doiCounts.entries()].filter(([, count]) => count > 1);
  checks.push({
    name: "duplicate_doi",
    status: duplicateDois.length === 0 ? "PASS" : "FAIL",
    details: duplicateDois.map(([doi, count]) => `${doi} (${count})`).join("; ")
  });

  const idCounts = new Map();
  for (const work of works) idCounts.set(work.openalex_id, (idCounts.get(work.openalex_id) ?? 0) + 1);
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1);
  checks.push({
    name: "duplicate_openalex_id",
    status: duplicateIds.length === 0 ? "PASS" : "FAIL",
    details: duplicateIds.map(([id, count]) => `${id} (${count})`).join("; ")
  });

  const verifiedRate = total > 0 ? verifiedOrVariation / total : 0;
  checks.push({
    name: "verified_rate",
    status: verifiedRate >= 0.9 ? "PASS" : "FAIL",
    details: `${verifiedOrVariation}/${total} (${(verifiedRate * 100).toFixed(2)}%)`
  });

  const aCoreRate = aCore.length > 0 ? aCoreVerifiedOrVariation / aCore.length : 0;
  checks.push({
    name: "a_core_verified_rate",
    status: aCoreRate >= 0.9 ? "PASS" : "FAIL",
    details: `${aCoreVerifiedOrVariation}/${aCore.length} (${(aCoreRate * 100).toFixed(2)}%)`
  });

  checks.push({
    name: "daily_top10_verified",
    status: top10Verified >= 9 ? "PASS" : "FAIL",
    details: `${top10Verified}/10`
  });

  const doiMismatch = works.filter((work) => work.doi_match === "MISMATCH").length;
  checks.push({
    name: "doi_mismatch",
    status: doiMismatch === 0 ? "PASS" : "FAIL",
    details: String(doiMismatch)
  });

  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    checks,
    verified_rate: Number(verifiedRate.toFixed(4)),
    a_core_verified_rate: Number(aCoreRate.toFixed(4)),
    daily_top10_verified: `${top10Verified}/10`
  };
}

async function main() {
  await mkdir(AUDIT_DIR, { recursive: true });
  const baseline = JSON.parse(await readFile(SOURCE_BASELINE, "utf8"));
  const works = baseline.works;
  const top10Ranks = new Map(baseline.simulated_top10.map((work) => [work.openalex_id, work.rank]));
  const verifiedWorks = [];

  for (const [index, work] of works.entries()) {
    const openalexDoi = normalizeDoi(work.doi);
    let result;

    if (!openalexDoi) {
      result = makeReviewResult(work, "REVIEW_REQUIRED", "DOI_MISSING");
    } else {
      const crossrefResult = await fetchCrossrefWork(openalexDoi);
      if (crossrefResult.found) {
        result = verifyFoundWork(work, crossrefResult.message);
      } else if (crossrefResult.status === 404) {
        result = makeReviewResult(work, "CROSSREF_NOT_FOUND", "CROSSREF_NOT_FOUND");
      } else {
        result = makeReviewResult(work, "ERROR", crossrefResult.error ?? "CROSSREF_API_ERROR");
      }
    }

    verifiedWorks.push(result);
    if (index < works.length - 1) await sleep(200 + Math.floor(Math.random() * 151));
  }

  const counts = {
    doi_match: countBy(verifiedWorks, "doi_match"),
    title_status: countBy(verifiedWorks, "title_status"),
    journal_match: countBy(verifiedWorks, "journal_match"),
    date_status: countBy(verifiedWorks, "date_status"),
    verification_status: countBy(verifiedWorks, "verification_status")
  };

  const simulatedTop10Status = baseline.simulated_top10.map((item) => {
    const verified = verifiedWorks.find((work) => work.openalex_id === item.openalex_id);
    return {
      rank: top10Ranks.get(item.openalex_id),
      openalex_id: item.openalex_id,
      title: item.title,
      verification_status: verified?.verification_status ?? "ERROR"
    };
  });

  const audit = {
    generated_at: new Date().toISOString(),
    source_baseline: "audit/openalex_baseline_v11_20261005.json",
    total_works: works.length,
    crossref_found: verifiedWorks.filter((work) => !["CROSSREF_NOT_FOUND", "ERROR"].includes(work.verification_status)).length,
    crossref_not_found: verifiedWorks.filter((work) => work.verification_status === "CROSSREF_NOT_FOUND").length,
    verified: verifiedWorks.filter((work) => work.verification_status === "VERIFIED").length,
    verified_with_variation: verifiedWorks.filter((work) => work.verification_status === "VERIFIED_WITH_VARIATION").length,
    review_required: verifiedWorks.filter((work) => work.verification_status === "REVIEW_REQUIRED").length,
    errors: verifiedWorks.filter((work) => work.verification_status === "ERROR").length,
    counts,
    simulated_top10_crossref_status: simulatedTop10Status,
    works: verifiedWorks
  };

  audit.validation = makeValidation(audit);

  await writeFile(OUTPUT_JSON, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_CSV, `${makeCsv(verifiedWorks)}\n`, "utf8");
  await writeFile(OUTPUT_MD, makeMarkdown(audit), "utf8");

  console.log("CROSSREF VERIFICATION");
  console.log(`Total: ${audit.total_works}`);
  console.log(`Crossref found: ${audit.crossref_found}`);
  console.log(`Crossref not found: ${audit.crossref_not_found}`);
  console.log(`Verified: ${audit.verified}`);
  console.log(`Verified with variation: ${audit.verified_with_variation}`);
  console.log(`Review required: ${audit.review_required}`);
  console.log(`Errors: ${audit.errors}`);
  console.log(`DOI match: ${counts.doi_match.MATCH ?? 0}`);
  console.log(`DOI mismatch: ${counts.doi_match.MISMATCH ?? 0}`);
  console.log(`Title match/minor: ${(counts.title_status.TITLE_MATCH ?? 0) + (counts.title_status.TITLE_MINOR_VARIATION ?? 0)}`);
  console.log(`Title mismatch: ${counts.title_status.TITLE_MISMATCH ?? 0}`);
  console.log(`Journal match/minor: ${(counts.journal_match.MATCH ?? 0) + (counts.journal_match.MINOR_VARIATION ?? 0)}`);
  console.log(`Journal mismatch: ${counts.journal_match.MISMATCH ?? 0}`);
  console.log(`A_CORE verified rate: ${(audit.validation.a_core_verified_rate * 100).toFixed(2)}%`);
  console.log(`Daily Top 10 verified: ${audit.validation.daily_top10_verified}`);
  console.log(`Validation: ${audit.validation.status}`);
  console.log(`Audit JSON: ${OUTPUT_JSON}`);
  console.log(`Audit CSV: ${OUTPUT_CSV}`);
  console.log(`Audit Markdown: ${OUTPUT_MD}`);

  if (audit.validation.status !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
