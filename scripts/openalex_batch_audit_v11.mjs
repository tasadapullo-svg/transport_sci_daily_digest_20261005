import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const AUDIT_DIR = path.join(ROOT_DIR, "audit");

const START_DATE = "2025-10-05";
const END_DATE = "2026-10-05";
const BASELINE_DATE = END_DATE.replaceAll("-", "");
const PER_QUERY_LIMIT = 50;
const OPENALEX_WORKS_URL = "https://api.openalex.org/works";

const OUTPUT_JSON = path.join(AUDIT_DIR, `openalex_baseline_v11_${BASELINE_DATE}.json`);
const OUTPUT_CSV = path.join(AUDIT_DIR, `openalex_baseline_v11_${BASELINE_DATE}.csv`);
const OUTPUT_MD = path.join(AUDIT_DIR, `openalex_baseline_v11_${BASELINE_DATE}.md`);
const V10_JSON = path.join(AUDIT_DIR, `openalex_baseline_${BASELINE_DATE}.json`);

const OPERATIONAL_KEEP_TERMS = [
  "traffic flow",
  "traffic speed",
  "traffic state",
  "travel time",
  "congestion",
  "signal control",
  "road network"
];

const PROBLEM_TOPIC_TERMS = [
  "autonomous vehicle",
  "computer vision",
  "pattern recognition",
  "robotic path planning",
  "maritime navigation",
  "air traffic management",
  "aerospace engineering"
];

const A_CORE_TERMS = [
  "forecasting",
  "forecast",
  "prediction",
  "predict",
  "travel time",
  "traffic state",
  "traffic flow",
  "traffic speed",
  "floating car data",
  "floating-car data",
  "fcd",
  "multisource",
  "multi-source",
  "multimodal",
  "multi-modal",
  "uncertainty",
  "probabilistic",
  "transferability",
  "transferable",
  "transfer learning",
  "cross-city",
  "cross-region",
  "domain adaptation",
  "generalization"
];

const B_RELATED_TERMS = [
  "traffic state estimation",
  "traffic estimation",
  "reliability",
  "resilience",
  "congestion propagation",
  "sensor reliability",
  "data reliability",
  "data quality",
  "traffic sensor"
];

const C_MANAGEMENT_TERMS = [
  "signal control",
  "traffic signal",
  "congestion management",
  "routing",
  "traffic operation",
  "traffic management",
  "incident",
  "control"
];

const MANAGEMENT_PENALTY_KEEP_TERMS = [
  "forecasting",
  "forecast",
  "prediction",
  "predict",
  "estimation",
  "reliability",
  "resilience"
];

const CONTAMINATION_AB_TERMS = [
  "ship trajectory",
  "air traffic",
  "airport",
  "rail freight",
  "port reliability",
  "traffic sign",
  "camera calibration",
  "pedestrian intention",
  "autonomous trajectory prediction"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesNormalizedPhrase(haystack, phrase) {
  return ` ${normalizeText(haystack)} `.includes(` ${normalizeText(phrase)} `);
}

function includesAllTerms(haystack, query) {
  const normalizedHaystack = ` ${normalizeText(haystack)} `;
  return normalizeText(query)
    .split(" ")
    .filter(Boolean)
    .every((term) => normalizedHaystack.includes(` ${term} `));
}

function matchedTerms(haystack, terms) {
  return terms.filter((term) => includesNormalizedPhrase(haystack, term));
}

function hasAnyTerm(haystack, terms) {
  return matchedTerms(haystack, terms).length > 0;
}

function normalizeDoi(doi) {
  if (!doi) return "";
  return String(doi)
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .trim();
}

function normalizeOpenAlexId(id) {
  return String(id ?? "").trim();
}

function normalizeSourceId(sourceId) {
  if (!sourceId) return "";
  return String(sourceId).split("/").pop();
}

function reconstructAbstract(abstractInvertedIndex) {
  if (!abstractInvertedIndex || typeof abstractInvertedIndex !== "object") return "";
  const wordsByPosition = [];
  for (const [word, positions] of Object.entries(abstractInvertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) wordsByPosition[position] = word;
  }
  return wordsByPosition.filter(Boolean).join(" ");
}

function workMatchesQuery(work, queryConfig) {
  const title = work.display_name ?? "";
  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const haystack = queryConfig.scope === "title" ? title : `${title} ${abstract}`;
  if (queryConfig.exact_phrase) return includesNormalizedPhrase(haystack, queryConfig.query);
  return includesAllTerms(haystack, queryConfig.query);
}

function primaryTopicFromWork(work) {
  const topic = work.primary_topic ?? {};
  return {
    primary_topic: topic.display_name ?? "",
    subfield: topic.subfield?.display_name ?? ""
  };
}

function journalFromWork(work, journalBySourceId) {
  const source = work.primary_location?.source ?? {};
  const sourceId = normalizeSourceId(source.id);
  return {
    source_id: sourceId,
    journal: journalBySourceId.get(sourceId)?.journal ?? source.display_name ?? "",
    tier: journalBySourceId.get(sourceId)?.tier ?? ""
  };
}

function buildOpenAlexUrl(queryConfig, sourceIds) {
  const filters = [
    "type:article",
    "has_abstract:true",
    `from_publication_date:${START_DATE}`,
    `to_publication_date:${END_DATE}`,
    `primary_location.source.id:${sourceIds.join("|")}`
  ];

  const params = new URLSearchParams();
  params.set("per-page", String(PER_QUERY_LIMIT));
  params.set("page", "1");
  params.set(
    "select",
    [
      "id",
      "doi",
      "display_name",
      "publication_date",
      "primary_location",
      "primary_topic",
      "open_access",
      "abstract_inverted_index"
    ].join(",")
  );

  if (queryConfig.scope === "title") {
    filters.push(`title.search:${queryConfig.query}`);
  } else {
    params.set("search", queryConfig.exact_phrase ? `"${queryConfig.query}"` : queryConfig.query);
  }

  params.set("filter", filters.join(","));
  return `${OPENALEX_WORKS_URL}?${params.toString()}`;
}

async function fetchJsonWithRetry(url, headers) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function scientificRemovalReason(work, scope) {
  const title = work.display_name ?? "";
  const topic = primaryTopicFromWork(work).primary_topic;
  const hardTerm = matchedTerms(title, scope.HARD_EXCLUDE_TERMS)[0];
  if (hardTerm) {
    return {
      removed_reason: "SCIENTIFIC_SCOPE_HARD_EXCLUDE",
      matched_term: hardTerm
    };
  }

  const conditionalTerm = matchedTerms(title, scope.CONDITIONAL_EXCLUDE_TERMS)[0];
  if (conditionalTerm && !hasAnyTerm(title, OPERATIONAL_KEEP_TERMS)) {
    return {
      removed_reason: "SCIENTIFIC_SCOPE_CONDITIONAL_EXCLUDE",
      matched_term: conditionalTerm
    };
  }

  const problemTopic = PROBLEM_TOPIC_TERMS.find((term) => includesNormalizedPhrase(topic, term));
  if (problemTopic && !hasAnyTerm(title, scope.CORE_TRAFFIC_TERMS)) {
    return {
      removed_reason: "SCIENTIFIC_SCOPE_TOPIC_EXCLUDE",
      matched_term: problemTopic
    };
  }

  return null;
}

function daysSincePublication(publicationDate) {
  if (!publicationDate) return Number.POSITIVE_INFINITY;
  const end = new Date(`${END_DATE}T00:00:00Z`);
  const published = new Date(`${publicationDate}T00:00:00Z`);
  if (Number.isNaN(published.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((end.getTime() - published.getTime()) / 86400000);
}

function classifyRelevance(work) {
  const title = work.title ?? "";
  const combined = `${work.title} ${work.abstract_text}`;
  const groups = new Set(work.query_groups);

  if (hasAnyTerm(combined, A_CORE_TERMS) || groups.has("CORE FORECASTING") || groups.has("DATA / MULTISOURCE") || groups.has("METHODS")) {
    return "A_CORE";
  }
  if (hasAnyTerm(combined, B_RELATED_TERMS) || groups.has("RELIABILITY / RESILIENCE")) {
    return "B_RELATED";
  }
  if (hasAnyTerm(title, C_MANAGEMENT_TERMS) || groups.has("MANAGEMENT")) {
    return "C_MANAGEMENT";
  }
  return "D_PERIPHERAL";
}

function scoreWork(work, scope) {
  const title = work.title ?? "";
  const highPriorityHits = matchedTerms(`${work.title} ${work.abstract_text}`, scope.HIGH_PRIORITY_TERMS);
  const ageDays = daysSincePublication(work.publication_date);
  let score = 0;

  if (work.tier === "A") score += 3;
  if (work.tier === "B") score += 2;
  if (work.doi) score += 1;
  if (work.abstract_text) score += 1;
  score += work.query_priority_max;
  if (work.matched_query_count >= 2) score += 1;
  if (work.matched_query_count >= 3) score += 2;
  if (hasAnyTerm(title, scope.CORE_TRAFFIC_TERMS)) score += 4;
  score += Math.min(4, highPriorityHits.length);
  if (ageDays <= 30) score += 3;
  else if (ageDays <= 90) score += 2;
  else if (ageDays <= 180) score += 1;

  const managementOnly = work.query_groups.length === 1 && work.query_groups[0] === "MANAGEMENT";
  if (managementOnly && !hasAnyTerm(title, MANAGEMENT_PENALTY_KEEP_TERMS)) score -= 2;
  if (hasAnyTerm(work.primary_topic, PROBLEM_TOPIC_TERMS) && !hasAnyTerm(title, scope.CORE_TRAFFIC_TERMS)) score -= 4;

  return {
    score,
    high_priority_terms_matched: highPriorityHits
  };
}

function classOrder(relevanceClass) {
  return {
    A_CORE: 0,
    B_RELATED: 1,
    C_MANAGEMENT: 2,
    D_PERIPHERAL: 3
  }[relevanceClass] ?? 4;
}

function sortWorks(a, b) {
  return (
    classOrder(a.relevance_class) - classOrder(b.relevance_class) ||
    b.score - a.score ||
    b.query_priority_max - a.query_priority_max ||
    b.matched_query_count - a.matched_query_count ||
    b.publication_date.localeCompare(a.publication_date) ||
    a.title.localeCompare(b.title)
  );
}

function canAddToTop10(work, selected, counts) {
  if ((counts.journals.get(work.journal) ?? 0) >= 3) return false;
  if (work.relevance_class === "C_MANAGEMENT" && counts.management >= 2) return false;
  for (const queryId of work.query_ids) {
    if ((counts.queries.get(queryId) ?? 0) >= 3) return false;
  }
  return !selected.some((item) => item.openalex_id === work.openalex_id);
}

function addToTop10(work, selected, counts) {
  selected.push(work);
  counts.journals.set(work.journal, (counts.journals.get(work.journal) ?? 0) + 1);
  for (const queryId of work.query_ids) {
    counts.queries.set(queryId, (counts.queries.get(queryId) ?? 0) + 1);
  }
  if (work.relevance_class === "C_MANAGEMENT") counts.management += 1;
}

function fillTop10FromPool(pool, selected, counts, limit = 10) {
  for (const work of pool) {
    if (selected.length >= limit) break;
    if (canAddToTop10(work, selected, counts)) addToTop10(work, selected, counts);
  }
}

function simulateDailyTop10(works) {
  const candidates = works.filter((work) => work.relevance_class !== "D_PERIPHERAL").sort(sortWorks);
  const selected = [];
  const counts = {
    journals: new Map(),
    queries: new Map(),
    management: 0
  };

  const crossBorder = candidates.find((work) => work.query_groups.includes("CROSS-BORDER"));
  if (crossBorder && canAddToTop10(crossBorder, selected, counts)) addToTop10(crossBorder, selected, counts);

  fillTop10FromPool(candidates.filter((work) => work.relevance_class === "A_CORE"), selected, counts, Math.max(5, selected.length));
  const dataMethodReliability = candidates.filter((work) =>
    work.query_groups.some((group) => ["DATA / MULTISOURCE", "METHODS", "RELIABILITY / RESILIENCE"].includes(group))
  );
  while (
    selected.length < 10 &&
    selected.filter((work) => work.query_groups.some((group) => ["DATA / MULTISOURCE", "METHODS", "RELIABILITY / RESILIENCE"].includes(group))).length < 2
  ) {
    const next = dataMethodReliability.find((work) => canAddToTop10(work, selected, counts));
    if (!next) break;
    addToTop10(next, selected, counts);
  }
  fillTop10FromPool(candidates, selected, counts);
  if (selected.length < 10) {
    fillTop10FromPool(works.filter((work) => work.relevance_class !== "D_PERIPHERAL").sort((a, b) => b.score - a.score), selected, counts);
  }

  return selected.slice(0, 10).map((work, index) => ({
    rank: index + 1,
    score: work.score,
    relevance_class: work.relevance_class,
    publication_date: work.publication_date,
    title: work.title,
    journal: work.journal,
    doi: work.doi,
    openalex_id: work.openalex_id,
    query_ids: work.query_ids,
    query_groups: work.query_groups
  }));
}

function csvEscape(value) {
  const stringValue = Array.isArray(value) ? value.join(";") : String(value ?? "");
  if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replaceAll('"', '""')}"`;
  return stringValue;
}

function makeCsv(works) {
  const columns = [
    "rank",
    "score",
    "relevance_class",
    "publication_date",
    "title",
    "journal",
    "doi",
    "openalex_id",
    "query_ids",
    "matched_query_count",
    "query_priority_max",
    "query_priority_sum",
    "primary_topic",
    "subfield",
    "oa_status"
  ];
  const rows = works.map((work, index) => ({
    rank: index + 1,
    score: work.score,
    relevance_class: work.relevance_class,
    publication_date: work.publication_date,
    title: work.title,
    journal: work.journal,
    doi: work.doi,
    openalex_id: work.openalex_id,
    query_ids: work.query_ids,
    matched_query_count: work.matched_query_count,
    query_priority_max: work.query_priority_max,
    query_priority_sum: work.query_priority_sum,
    primary_topic: work.primary_topic,
    subfield: work.subfield,
    oa_status: work.oa_status
  }));
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\n");
}

function tableRow(values) {
  return `| ${values.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ")} |`;
}

function makeMarkdown(audit) {
  const zeroResultQueries = audit.query_statistics.filter((query) => query.filtered_count === 0);
  const classCounts = audit.relevance_class_counts;
  const topCore = audit.works.filter((work) => work.relevance_class === "A_CORE").slice(0, 20);
  const topRelated = audit.works.filter((work) => work.relevance_class === "B_RELATED").slice(0, 20);

  const lines = [];
  lines.push("# OpenAlex Transportation Scientific Scope Baseline v1.1");
  lines.push("");
  lines.push(`Generated at: ${audit.generated_at}`);
  lines.push(`Date window: ${audit.date_window.from} to ${audit.date_window.to}`);
  lines.push("");
  lines.push("## V1.0 vs V1.1");
  lines.push("");
  lines.push(`- v1.0 unique = ${audit.v10_unique_count}`);
  lines.push(`- v1.1 unique = ${audit.unique_count}`);
  lines.push(`- scientific scope removed = ${audit.scientific_scope_removed}`);
  lines.push(`- hard excluded = ${audit.hard_excluded}`);
  lines.push(`- conditional excluded = ${audit.conditional_excluded}`);
  lines.push(`- A_CORE = ${classCounts.A_CORE}`);
  lines.push(`- B_RELATED = ${classCounts.B_RELATED}`);
  lines.push(`- C_MANAGEMENT = ${classCounts.C_MANAGEMENT}`);
  lines.push(`- D_PERIPHERAL = ${classCounts.D_PERIPHERAL}`);
  lines.push("");
  lines.push("JCR quartile has not been verified.");
  lines.push("");
  lines.push("## Query Statistics");
  lines.push("");
  lines.push(tableRow(["query_id", "group", "priority", "raw", "filtered", "unique contribution", "precision"]));
  lines.push(tableRow(["---", "---", "---:", "---:", "---:", "---:", "---"]));
  for (const query of audit.query_statistics) {
    lines.push(tableRow([query.id, query.group, query.priority, query.raw_count, query.filtered_count, query.unique_contribution, "NEEDS_REVIEW"]));
  }
  lines.push("");
  lines.push("## Zero-result Queries");
  lines.push("");
  lines.push(zeroResultQueries.length ? zeroResultQueries.map((query) => `- ${query.id}: ${query.query}`).join("\n") : "None.");
  lines.push("");
  lines.push("## Top 20 A_CORE");
  lines.push("");
  lines.push(tableRow(["rank", "score", "date", "title", "journal", "query_ids"]));
  lines.push(tableRow(["---:", "---:", "---", "---", "---", "---"]));
  for (const [index, work] of topCore.entries()) {
    lines.push(tableRow([index + 1, work.score, work.publication_date, work.title, work.journal, work.query_ids.join(";")]));
  }
  lines.push("");
  lines.push("## Top 20 B_RELATED");
  lines.push("");
  lines.push(tableRow(["rank", "score", "date", "title", "journal", "query_ids"]));
  lines.push(tableRow(["---:", "---:", "---", "---", "---", "---"]));
  for (const [index, work] of topRelated.entries()) {
    lines.push(tableRow([index + 1, work.score, work.publication_date, work.title, work.journal, work.query_ids.join(";")]));
  }
  lines.push("");
  lines.push("## Simulated Daily Top 10");
  lines.push("");
  lines.push(tableRow(["rank", "score", "class", "date", "title", "journal", "query_ids"]));
  lines.push(tableRow(["---:", "---:", "---", "---", "---", "---", "---"]));
  for (const item of audit.simulated_top10) {
    lines.push(tableRow([item.rank, item.score, item.relevance_class, item.publication_date, item.title, item.journal, item.query_ids.join(";")]));
  }
  lines.push("");
  lines.push("## Removed Scientific Scope Papers");
  lines.push("");
  if (audit.scientific_scope_removed_records.length === 0) {
    lines.push("None.");
  } else {
    lines.push(tableRow(["query_id", "reason", "matched_term", "title", "journal", "openalex_id"]));
    lines.push(tableRow(["---", "---", "---", "---", "---", "---"]));
    for (const record of audit.scientific_scope_removed_records) {
      lines.push(tableRow([record.query_id, record.removed_reason, record.matched_term, record.title, record.journal, record.openalex_id]));
    }
  }
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(`- Status: ${audit.validation.status}`);
  for (const check of audit.validation.checks) {
    lines.push(`- ${check.name}: ${check.status}${check.details ? ` - ${check.details}` : ""}`);
  }
  lines.push("");
  lines.push("## Failed Queries");
  lines.push("");
  lines.push(audit.failed_queries.length ? audit.failed_queries.map((query) => `- ${query.id}: ${query.error}`).join("\n") : "None.");
  return `${lines.join("\n")}\n`;
}

function makeValidation(works, sourceIds, simulatedTop10) {
  const checks = [];
  const abWorks = works.filter((work) => ["A_CORE", "B_RELATED"].includes(work.relevance_class));
  const contamination = abWorks
    .filter((work) => CONTAMINATION_AB_TERMS.some((term) => includesNormalizedPhrase(work.title, term)))
    .map((work) => `${work.openalex_id}: ${work.title}`);
  checks.push({
    name: "ab_scope_contamination",
    status: contamination.length === 0 ? "PASS" : "FAIL",
    details: contamination.join("; ")
  });

  const trajectoryCore = works
    .filter((work) => work.relevance_class === "A_CORE")
    .filter((work) => includesNormalizedPhrase(work.title, "trajectory prediction") && !hasAnyTerm(work.title, OPERATIONAL_KEEP_TERMS))
    .map((work) => `${work.openalex_id}: ${work.title}`);
  checks.push({
    name: "trajectory_prediction_a_core",
    status: trajectoryCore.length === 0 ? "PASS" : "FAIL",
    details: trajectoryCore.join("; ")
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

  const invalidSources = works.filter((work) => !sourceIds.includes(work.source_id));
  checks.push({
    name: "source_whitelist",
    status: invalidSources.length === 0 ? "PASS" : "FAIL",
    details: invalidSources.map((work) => `${work.source_id}: ${work.title}`).join("; ")
  });

  const top20 = works.slice(0, 20);
  const coreRelevantTop20 = top20.filter((work) => ["A_CORE", "B_RELATED"].includes(work.relevance_class)).length;
  checks.push({
    name: "top20_core_precision",
    status: coreRelevantTop20 >= Math.min(15, top20.length) ? "PASS" : "FAIL",
    details: `${coreRelevantTop20}/${top20.length}`
  });

  const managementTop10 = simulatedTop10.filter((work) => work.relevance_class === "C_MANAGEMENT").length;
  checks.push({
    name: "daily_top10_management_cap",
    status: managementTop10 <= 2 ? "PASS" : "FAIL",
    details: `${managementTop10}/10`
  });

  checks.push({
    name: "non_empty_outputs",
    status: works.length > 0 ? "PASS" : "FAIL",
    details: works.length > 0 ? "" : "No unique works were produced."
  });

  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    checks,
    top20_core_precision: `${coreRelevantTop20}/${top20.length}`,
    simulated_top10_precision: `${simulatedTop10.filter((work) => ["A_CORE", "B_RELATED", "C_MANAGEMENT"].includes(work.relevance_class)).length}/${simulatedTop10.length}`
  };
}

async function main() {
  await mkdir(AUDIT_DIR, { recursive: true });
  const journals = JSON.parse(await readFile(path.join(CONFIG_DIR, "journals_target.json"), "utf8"));
  const queries = JSON.parse(await readFile(path.join(CONFIG_DIR, "search_queries_v11.json"), "utf8"));
  const scope = JSON.parse(await readFile(path.join(CONFIG_DIR, "scientific_scope.json"), "utf8"));
  const v10 = JSON.parse(await readFile(V10_JSON, "utf8"));
  const journalBySourceId = new Map(journals.map((journal) => [journal.source_id, journal]));
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const sourceIds = journals.map((journal) => journal.source_id);

  const headers = {
    "User-Agent": "traffic-q1-daily-wecom OpenAlex scientific baseline audit"
  };
  if (process.env.OPENALEX_API_KEY) headers.Authorization = `Bearer ${process.env.OPENALEX_API_KEY}`;

  const queryStatistics = [];
  const failedQueries = [];
  const allKeptHits = [];
  const removedRecords = [];
  let rawCount = 0;
  let localMatchedCount = 0;

  for (const queryConfig of queries) {
    const stat = {
      id: queryConfig.id,
      group: queryConfig.group,
      priority: queryConfig.priority,
      query: queryConfig.query,
      scope: queryConfig.scope,
      exact_phrase: Boolean(queryConfig.exact_phrase),
      status: "success",
      raw_count: 0,
      local_match_count: 0,
      filtered_count: 0,
      scientific_scope_removed: 0,
      hard_excluded: 0,
      conditional_excluded: 0,
      topic_excluded: 0,
      unique_contribution: 0,
      duplicates_in_query: 0,
      duplicate_rate: 0
    };

    try {
      const payload = await fetchJsonWithRetry(buildOpenAlexUrl(queryConfig, sourceIds), headers);
      const results = Array.isArray(payload.results) ? payload.results : [];
      stat.raw_count = results.length;
      rawCount += results.length;

      for (const work of results) {
        if (!workMatchesQuery(work, queryConfig)) continue;
        localMatchedCount += 1;
        stat.local_match_count += 1;

        const journalMeta = journalFromWork(work, journalBySourceId);
        const removal = scientificRemovalReason(work, scope);
        if (removal) {
          stat.scientific_scope_removed += 1;
          if (removal.removed_reason === "SCIENTIFIC_SCOPE_HARD_EXCLUDE") stat.hard_excluded += 1;
          if (removal.removed_reason === "SCIENTIFIC_SCOPE_CONDITIONAL_EXCLUDE") stat.conditional_excluded += 1;
          if (removal.removed_reason === "SCIENTIFIC_SCOPE_TOPIC_EXCLUDE") stat.topic_excluded += 1;
          removedRecords.push({
            query_id: queryConfig.id,
            openalex_id: normalizeOpenAlexId(work.id),
            doi: normalizeDoi(work.doi),
            title: work.display_name ?? "",
            journal: journalMeta.journal,
            source_id: journalMeta.source_id,
            removed_reason: removal.removed_reason,
            matched_term: removal.matched_term
          });
          continue;
        }

        stat.filtered_count += 1;
        allKeptHits.push({
          query_id: queryConfig.id,
          raw_work: work
        });
      }
    } catch (error) {
      stat.status = "failed";
      stat.error = error.message;
      failedQueries.push({
        id: queryConfig.id,
        query: queryConfig.query,
        error: error.message
      });
    }

    queryStatistics.push(stat);
    await sleep(150 + Math.floor(Math.random() * 151));
  }

  const uniqueByKey = new Map();
  const seenKeys = new Set();
  const queryStatById = new Map(queryStatistics.map((stat) => [stat.id, stat]));
  for (const hit of allKeptHits) {
    const work = hit.raw_work;
    const doi = normalizeDoi(work.doi);
    const openalexId = normalizeOpenAlexId(work.id);
    const dedupeKey = doi ? `doi:${doi}` : `openalex:${openalexId}`;
    const queryConfig = queryById.get(hit.query_id);

    if (!uniqueByKey.has(dedupeKey)) {
      const journalMeta = journalFromWork(work, journalBySourceId);
      const topic = primaryTopicFromWork(work);
      uniqueByKey.set(dedupeKey, {
        openalex_id: openalexId,
        doi,
        title: work.display_name ?? "",
        publication_date: work.publication_date ?? "",
        journal: journalMeta.journal,
        source_id: journalMeta.source_id,
        tier: journalMeta.tier,
        query_ids: [],
        query_groups: [],
        query_priority_max: 0,
        query_priority_sum: 0,
        matched_query_count: 0,
        primary_topic: topic.primary_topic,
        subfield: topic.subfield,
        oa_status: work.open_access?.oa_status ?? "",
        abstract_text: reconstructAbstract(work.abstract_inverted_index)
      });
    }

    const uniqueWork = uniqueByKey.get(dedupeKey);
    if (!uniqueWork.query_ids.includes(hit.query_id)) {
      uniqueWork.query_ids.push(hit.query_id);
      uniqueWork.matched_query_count = uniqueWork.query_ids.length;
      uniqueWork.query_priority_max = Math.max(uniqueWork.query_priority_max, queryConfig.priority);
      uniqueWork.query_priority_sum += queryConfig.priority;
      if (!uniqueWork.query_groups.includes(queryConfig.group)) uniqueWork.query_groups.push(queryConfig.group);
    }

    if (!seenKeys.has(dedupeKey)) {
      seenKeys.add(dedupeKey);
      queryStatById.get(hit.query_id).unique_contribution += 1;
    }
  }

  const works = [...uniqueByKey.values()]
    .map((work) => {
      const relevanceClass = classifyRelevance(work);
      const scoreResult = scoreWork(work, scope);
      return {
        openalex_id: work.openalex_id,
        doi: work.doi,
        title: work.title,
        publication_date: work.publication_date,
        journal: work.journal,
        source_id: work.source_id,
        query_ids: work.query_ids.sort(),
        query_groups: work.query_groups.sort(),
        query_priority_max: work.query_priority_max,
        query_priority_sum: work.query_priority_sum,
        matched_query_count: work.matched_query_count,
        primary_topic: work.primary_topic,
        subfield: work.subfield,
        oa_status: work.oa_status,
        relevance_class: relevanceClass,
        high_priority_terms_matched: scoreResult.high_priority_terms_matched,
        score: scoreResult.score
      };
    })
    .sort(sortWorks);

  for (const stat of queryStatistics) {
    stat.duplicates_in_query = Math.max(0, stat.filtered_count - stat.unique_contribution);
    stat.duplicate_rate = stat.filtered_count > 0 ? stat.duplicates_in_query / stat.filtered_count : 0;
  }

  const simulatedTop10 = simulateDailyTop10(works);
  const classCounts = {
    A_CORE: works.filter((work) => work.relevance_class === "A_CORE").length,
    B_RELATED: works.filter((work) => work.relevance_class === "B_RELATED").length,
    C_MANAGEMENT: works.filter((work) => work.relevance_class === "C_MANAGEMENT").length,
    D_PERIPHERAL: works.filter((work) => work.relevance_class === "D_PERIPHERAL").length
  };

  const filteredCount = allKeptHits.length;
  const audit = {
    version: "1.1",
    generated_at: new Date().toISOString(),
    date_window: {
      from: START_DATE,
      to: END_DATE
    },
    v10_unique_count: v10.unique_count,
    query_statistics: queryStatistics,
    failed_queries: failedQueries,
    raw_count: rawCount,
    local_matched_count: localMatchedCount,
    filtered_count: filteredCount,
    unique_count: works.length,
    duplicates_removed: filteredCount - works.length,
    scientific_scope_removed: removedRecords.length,
    hard_excluded: removedRecords.filter((record) => record.removed_reason === "SCIENTIFIC_SCOPE_HARD_EXCLUDE").length,
    conditional_excluded: removedRecords.filter((record) => record.removed_reason === "SCIENTIFIC_SCOPE_CONDITIONAL_EXCLUDE").length,
    topic_excluded: removedRecords.filter((record) => record.removed_reason === "SCIENTIFIC_SCOPE_TOPIC_EXCLUDE").length,
    relevance_class_counts: classCounts,
    scientific_scope_removed_records: removedRecords,
    simulated_top10: simulatedTop10,
    works
  };
  audit.validation = makeValidation(works, sourceIds, simulatedTop10);

  await writeFile(OUTPUT_JSON, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_CSV, `${makeCsv(works)}\n`, "utf8");
  await writeFile(OUTPUT_MD, makeMarkdown(audit), "utf8");

  console.log("OPENALEX SCIENTIFIC BASELINE V1.1");
  console.log(`Queries: ${queries.length}`);
  console.log(`Raw: ${audit.raw_count}`);
  console.log(`Filtered: ${audit.filtered_count}`);
  console.log(`Unique: ${audit.unique_count}`);
  console.log(`Scientific scope removed: ${audit.scientific_scope_removed}`);
  console.log(`Hard excluded: ${audit.hard_excluded}`);
  console.log(`Conditional excluded: ${audit.conditional_excluded}`);
  console.log(`A_CORE: ${classCounts.A_CORE}`);
  console.log(`B_RELATED: ${classCounts.B_RELATED}`);
  console.log(`C_MANAGEMENT: ${classCounts.C_MANAGEMENT}`);
  console.log(`D_PERIPHERAL: ${classCounts.D_PERIPHERAL}`);
  console.log(`Top 20 core precision: ${audit.validation.top20_core_precision}`);
  console.log(`Simulated Daily Top 10 precision: ${audit.validation.simulated_top10_precision}`);
  console.log(`Validation: ${audit.validation.status}`);
  console.log(`Audit JSON: ${OUTPUT_JSON}`);
  console.log(`Audit CSV: ${OUTPUT_CSV}`);
  console.log(`Audit Markdown: ${OUTPUT_MD}`);

  if (audit.validation.status !== "PASS") {
    for (const check of audit.validation.checks.filter((item) => item.status === "FAIL")) {
      console.error(`${check.name}: ${check.details}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
