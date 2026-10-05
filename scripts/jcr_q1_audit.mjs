import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const AUDIT_DIR = path.join(ROOT_DIR, "audit");

const BASELINE_DATE = "20261005";
const JCR_RELEASE_YEAR = 2026;
const METRIC_YEAR = 2025;
const OPENALEX_BASELINE = path.join(AUDIT_DIR, `openalex_baseline_v11_${BASELINE_DATE}.json`);
const CROSSREF_BASELINE = path.join(AUDIT_DIR, `crossref_verification_${BASELINE_DATE}.json`);
const JCR_CONFIG = path.join(CONFIG_DIR, "jcr_journal_baseline_2026.json");
const OUTPUT_JSON = path.join(AUDIT_DIR, `jcr_q1_baseline_${BASELINE_DATE}.json`);
const OUTPUT_CSV = path.join(AUDIT_DIR, `jcr_q1_baseline_${BASELINE_DATE}.csv`);
const OUTPUT_MD = path.join(AUDIT_DIR, `jcr_q1_baseline_${BASELINE_DATE}.md`);

const CROSSREF_VERIFIED_STATUSES = new Set(["VERIFIED", "VERIFIED_WITH_VARIATION"]);
const CLASS_ORDER = {
  A_CORE: 0,
  B_RELATED: 1,
  C_MANAGEMENT: 2,
  D_PERIPHERAL: 3
};

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

function classRank(work) {
  return CLASS_ORDER[work.relevance_class] ?? 9;
}

function sortForDaily(left, right) {
  const classDiff = classRank(left) - classRank(right);
  if (classDiff !== 0) return classDiff;

  const scoreDiff = right.score - left.score;
  if (Math.abs(scoreDiff) <= 1) {
    const dateDiff = right.publication_date.localeCompare(left.publication_date);
    if (dateDiff !== 0) return dateDiff;
  }
  if (scoreDiff !== 0) return scoreDiff;
  return right.publication_date.localeCompare(left.publication_date) || left.title.localeCompare(right.title);
}

function sortByRelevance(left, right) {
  return (
    classRank(left) - classRank(right) ||
    right.score - left.score ||
    right.publication_date.localeCompare(left.publication_date) ||
    left.title.localeCompare(right.title)
  );
}

function canAddTop10(work, selected, counts) {
  if (selected.some((item) => item.openalex_id === work.openalex_id)) return false;
  if ((counts.journal.get(work.journal) ?? 0) >= 3) return false;
  if (work.relevance_class === "C_MANAGEMENT" && counts.management >= 2) return false;
  return true;
}

function addTop10(work, selected, counts) {
  selected.push({
    rank: selected.length + 1,
    openalex_id: work.openalex_id,
    doi: work.doi,
    title: work.title,
    journal: work.journal,
    source_id: work.source_id,
    publication_date: work.publication_date,
    score: work.score,
    relevance_class: work.relevance_class,
    jcr_best_quartile: work.jcr_best_quartile,
    daily_q1_eligible: work.daily_q1_eligible,
    journal_role: work.journal_role,
    crossref_verification_status: work.crossref_verification_status,
    query_ids: work.query_ids
  });
  counts.journal.set(work.journal, (counts.journal.get(work.journal) ?? 0) + 1);
  if (work.relevance_class === "C_MANAGEMENT") counts.management += 1;
}

function simulateJcrQ1Top10(works) {
  const candidates = works
    .filter((work) => work.daily_q1_eligible)
    .filter((work) => CROSSREF_VERIFIED_STATUSES.has(work.crossref_verification_status))
    .sort(sortForDaily);

  const selected = [];
  const counts = {
    journal: new Map(),
    management: 0
  };

  for (const work of candidates) {
    if (selected.length >= 10) break;
    if (canAddTop10(work, selected, counts)) addTop10(work, selected, counts);
  }

  return selected;
}

function csvEscape(value) {
  const stringValue = Array.isArray(value) ? value.join(";") : String(value ?? "");
  if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replaceAll('"', '""')}"`;
  return stringValue;
}

function makeCsv(works) {
  const columns = [
    "rank",
    "jcr_best_quartile",
    "daily_q1_eligible",
    "journal_role",
    "relevance_class",
    "score",
    "publication_date",
    "title",
    "journal",
    "source_id",
    "doi",
    "openalex_id",
    "crossref_verification_status",
    "query_ids"
  ];

  const rows = works.map((work, index) => ({
    rank: index + 1,
    jcr_best_quartile: work.jcr_best_quartile,
    daily_q1_eligible: work.daily_q1_eligible,
    journal_role: work.journal_role,
    relevance_class: work.relevance_class,
    score: work.score,
    publication_date: work.publication_date,
    title: work.title,
    journal: work.journal,
    source_id: work.source_id,
    doi: work.doi,
    openalex_id: work.openalex_id,
    crossref_verification_status: work.crossref_verification_status,
    query_ids: work.query_ids
  }));

  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\n");
}

function countBy(items, getter) {
  const counts = {};
  for (const item of items) {
    const key = getter(item) ?? "UNVERIFIED";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function tableRow(values) {
  return `| ${values.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ")} |`;
}

function makeMarkdown(audit) {
  const lines = [];
  lines.push("# JCR Q1 Journal Eligibility Baseline v1.0");
  lines.push("");
  lines.push(`Generated at: ${audit.generated_at}`);
  lines.push(`JCR release year: ${audit.jcr_release_year}`);
  lines.push(`Metric year: ${audit.metric_year}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total works: ${audit.total_works}`);
  lines.push(`- JCR Q1 works: ${audit.work_counts.Q1}`);
  lines.push(`- JCR Q2 works: ${audit.work_counts.Q2}`);
  lines.push(`- JCR Q3 works: ${audit.work_counts.Q3}`);
  lines.push(`- Unverified works: ${audit.work_counts.UNVERIFIED}`);
  lines.push(`- A_CORE Q1 works: ${audit.relevance_q1_counts.A_CORE}`);
  lines.push(`- B_RELATED Q1 works: ${audit.relevance_q1_counts.B_RELATED}`);
  lines.push(`- C_MANAGEMENT Q1 works: ${audit.relevance_q1_counts.C_MANAGEMENT}`);
  lines.push("");
  lines.push("JCR quartile eligibility is taken only from the frozen JCR 2026 / metric year 2025 baseline. Scopus Q1, SJR Q1, CiteScore Q1, OpenAlex, and Crossref are not used to infer JCR quartiles.");
  lines.push("");
  lines.push("## Crossref Date Strategy");
  lines.push("");
  lines.push("OpenAlex publication_date is used for discovery freshness, daily ranking, and recent-window filtering. Crossref publication date is used for metadata verification. Papers are not removed only because a Crossref issue date is later than an OpenAlex online-first date.");
  lines.push("");
  lines.push("## Journal Counts");
  lines.push("");
  lines.push(tableRow(["journal", "source_id", "paper_count", "quartile", "daily_q1_eligible"]));
  lines.push(tableRow(["---", "---", "---:", "---", "---"]));
  for (const journal of audit.journal_counts) {
    lines.push(tableRow([journal.journal, journal.source_id, journal.paper_count, journal.quartile, journal.daily_q1_eligible]));
  }
  lines.push("");
  lines.push("## JCR_Q1_SIMULATED_TOP10");
  lines.push("");
  lines.push(tableRow(["rank", "score", "class", "date", "title", "journal", "Crossref"]));
  lines.push(tableRow(["---:", "---:", "---", "---", "---", "---", "---"]));
  for (const work of audit.jcr_q1_simulated_top10) {
    lines.push(tableRow([work.rank, work.score, work.relevance_class, work.publication_date, work.title, work.journal, work.crossref_verification_status]));
  }
  lines.push("");
  lines.push("## SUPPLEMENTARY NON-Q1 PAPERS");
  lines.push("");
  lines.push(`- Q2 count: ${audit.work_counts.Q2}`);
  lines.push(`- Q3 count: ${audit.work_counts.Q3}`);
  lines.push("");
  lines.push("These papers are retained for expanded reading, supplementary reading, and highly relevant non-JCR-Q1 research, but they must not enter the default JCR Q1 Daily Top 10.");
  lines.push("");
  lines.push(tableRow(["rank", "quartile", "score", "class", "date", "title", "journal"]));
  lines.push(tableRow(["---:", "---", "---:", "---", "---", "---", "---"]));
  for (const [index, work] of audit.supplementary_non_q1_top20.entries()) {
    lines.push(tableRow([index + 1, work.jcr_best_quartile, work.score, work.relevance_class, work.publication_date, work.title, work.journal]));
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
  const top10 = audit.jcr_q1_simulated_top10;

  checks.push({
    name: "all_works_mapped",
    status: works.length === 169 && works.every((work) => work.jcr_best_quartile !== "UNVERIFIED") ? "PASS" : "FAIL",
    details: `${works.filter((work) => work.jcr_best_quartile !== "UNVERIFIED").length}/${works.length}`
  });

  checks.push({
    name: "source_id_present",
    status: works.every((work) => Boolean(work.source_id)) ? "PASS" : "FAIL",
    details: works.filter((work) => !work.source_id).map((work) => work.openalex_id).join("; ")
  });

  checks.push({
    name: "daily_top10_count",
    status: top10.length === 10 ? "PASS" : "FAIL",
    details: `${top10.length}/10`
  });

  checks.push({
    name: "top10_all_jcr_q1",
    status: top10.every((work) => work.jcr_best_quartile === "Q1" && work.daily_q1_eligible) ? "PASS" : "FAIL",
    details: top10.filter((work) => work.jcr_best_quartile !== "Q1" || !work.daily_q1_eligible).map((work) => `${work.jcr_best_quartile}: ${work.title}`).join("; ")
  });

  checks.push({
    name: "top10_crossref_verified",
    status: top10.every((work) => CROSSREF_VERIFIED_STATUSES.has(work.crossref_verification_status)) ? "PASS" : "FAIL",
    details: `${top10.filter((work) => CROSSREF_VERIFIED_STATUSES.has(work.crossref_verification_status)).length}/10`
  });

  const top10ACore = top10.filter((work) => work.relevance_class === "A_CORE").length;
  checks.push({
    name: "top10_a_core_minimum",
    status: top10ACore >= 7 ? "PASS" : "FAIL",
    details: `${top10ACore}/10`
  });

  const nonQ1Leak = top10.filter((work) => ["Q2", "Q3"].includes(work.jcr_best_quartile)).length;
  checks.push({
    name: "non_q1_leakage",
    status: nonQ1Leak === 0 ? "PASS" : "FAIL",
    details: String(nonQ1Leak)
  });

  const doiCounts = new Map();
  for (const work of works) {
    if (!work.doi) continue;
    doiCounts.set(work.doi, (doiCounts.get(work.doi) ?? 0) + 1);
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

  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    checks
  };
}

async function main() {
  await mkdir(AUDIT_DIR, { recursive: true });

  const openalex = JSON.parse(await readFile(OPENALEX_BASELINE, "utf8"));
  const crossref = JSON.parse(await readFile(CROSSREF_BASELINE, "utf8"));
  const jcrConfig = JSON.parse(await readFile(JCR_CONFIG, "utf8"));

  const jcrBySource = new Map(jcrConfig.map((journal) => [journal.source_id, journal]));
  const crossrefByOpenAlex = new Map(crossref.works.map((work) => [work.openalex_id, work]));

  const works = openalex.works
    .map((work) => {
      const jcr = jcrBySource.get(work.source_id);
      const crossrefWork = crossrefByOpenAlex.get(work.openalex_id);
      return {
        ...work,
        doi: normalizeDoi(work.doi),
        jcr_release_year: jcr?.jcr_release_year ?? null,
        jcr_metric_year: jcr?.metric_year ?? null,
        jcr_best_quartile: jcr?.jcr_best_quartile ?? "UNVERIFIED",
        daily_q1_eligible: Boolean(jcr?.daily_q1_eligible),
        journal_role: jcr?.journal_role ?? "UNVERIFIED",
        crossref_verification_status: crossrefWork?.verification_status ?? "MISSING"
      };
    })
    .sort(sortByRelevance);

  const q1Works = works.filter((work) => work.jcr_best_quartile === "Q1");
  const q2Works = works.filter((work) => work.jcr_best_quartile === "Q2");
  const q3Works = works.filter((work) => work.jcr_best_quartile === "Q3");
  const unverifiedWorks = works.filter((work) => work.jcr_best_quartile === "UNVERIFIED");
  const journalCountMap = new Map();

  for (const journal of jcrConfig) {
    journalCountMap.set(journal.source_id, {
      journal: journal.journal,
      source_id: journal.source_id,
      paper_count: 0,
      quartile: journal.jcr_best_quartile,
      daily_q1_eligible: journal.daily_q1_eligible
    });
  }
  for (const work of works) {
    if (!journalCountMap.has(work.source_id)) {
      journalCountMap.set(work.source_id, {
        journal: work.journal,
        source_id: work.source_id,
        paper_count: 0,
        quartile: "UNVERIFIED",
        daily_q1_eligible: false
      });
    }
    journalCountMap.get(work.source_id).paper_count += 1;
  }

  const jcrQ1Top10 = simulateJcrQ1Top10(works);
  const supplementaryTop20 = works.filter((work) => ["Q2", "Q3"].includes(work.jcr_best_quartile)).sort(sortByRelevance).slice(0, 20);
  const journalQuartileCounts = countBy(jcrConfig, (journal) => journal.jcr_best_quartile);

  const audit = {
    generated_at: new Date().toISOString(),
    source_baselines: {
      openalex: "audit/openalex_baseline_v11_20261005.json",
      crossref: "audit/crossref_verification_20261005.json",
      jcr_config: "config/jcr_journal_baseline_2026.json"
    },
    jcr_release_year: JCR_RELEASE_YEAR,
    metric_year: METRIC_YEAR,
    total_journals: jcrConfig.length,
    journal_counts_by_quartile: {
      Q1: journalQuartileCounts.Q1 ?? 0,
      Q2: journalQuartileCounts.Q2 ?? 0,
      Q3: journalQuartileCounts.Q3 ?? 0,
      UNVERIFIED: journalQuartileCounts.UNVERIFIED ?? 0
    },
    total_works: works.length,
    work_counts: {
      Q1: q1Works.length,
      Q2: q2Works.length,
      Q3: q3Works.length,
      UNVERIFIED: unverifiedWorks.length
    },
    relevance_q1_counts: {
      A_CORE: q1Works.filter((work) => work.relevance_class === "A_CORE").length,
      B_RELATED: q1Works.filter((work) => work.relevance_class === "B_RELATED").length,
      C_MANAGEMENT: q1Works.filter((work) => work.relevance_class === "C_MANAGEMENT").length,
      D_PERIPHERAL: q1Works.filter((work) => work.relevance_class === "D_PERIPHERAL").length
    },
    journal_counts: [...journalCountMap.values()].sort((left, right) => right.paper_count - left.paper_count || left.journal.localeCompare(right.journal)),
    jcr_q1_simulated_top10: jcrQ1Top10,
    supplementary_non_q1_top20: supplementaryTop20,
    works
  };

  audit.validation = makeValidation(audit);

  await writeFile(OUTPUT_JSON, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_CSV, `${makeCsv(works)}\n`, "utf8");
  await writeFile(OUTPUT_MD, makeMarkdown(audit), "utf8");

  const top10Verified = jcrQ1Top10.filter((work) => CROSSREF_VERIFIED_STATUSES.has(work.crossref_verification_status)).length;
  const nonQ1Leak = jcrQ1Top10.filter((work) => ["Q2", "Q3"].includes(work.jcr_best_quartile)).length;

  console.log("JCR Q1 BASELINE");
  console.log(`JCR release: ${JCR_RELEASE_YEAR}`);
  console.log(`Metric year: ${METRIC_YEAR}`);
  console.log(`Journals total: ${jcrConfig.length}`);
  console.log(`Q1 journals: ${audit.journal_counts_by_quartile.Q1}`);
  console.log(`Q2 journals: ${audit.journal_counts_by_quartile.Q2}`);
  console.log(`Q3 journals: ${audit.journal_counts_by_quartile.Q3}`);
  console.log(`Unverified journals: ${audit.journal_counts_by_quartile.UNVERIFIED}`);
  console.log(`Works total: ${works.length}`);
  console.log(`Q1 works: ${audit.work_counts.Q1}`);
  console.log(`Q2 works: ${audit.work_counts.Q2}`);
  console.log(`Q3 works: ${audit.work_counts.Q3}`);
  console.log(`A_CORE Q1: ${audit.relevance_q1_counts.A_CORE}`);
  console.log(`Q1 Daily Top 10: ${jcrQ1Top10.length}/10`);
  console.log(`Non-Q1 leaked into Top10: ${nonQ1Leak}`);
  console.log(`Crossref verified Top10: ${top10Verified}/10`);
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
