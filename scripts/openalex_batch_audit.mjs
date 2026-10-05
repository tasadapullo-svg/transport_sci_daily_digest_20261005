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

const OUTPUT_JSON = path.join(AUDIT_DIR, `openalex_baseline_${BASELINE_DATE}.json`);
const OUTPUT_CSV = path.join(AUDIT_DIR, `openalex_baseline_${BASELINE_DATE}.csv`);
const OUTPUT_MD = path.join(AUDIT_DIR, `openalex_baseline_${BASELINE_DATE}.md`);

const NON_ROAD_MODE_TERMS = [
  "air traffic",
  "aircraft",
  "aviation",
  "vessel traffic",
  "vessel",
  "maritime",
  "shipping",
  "ship traffic",
  "waterway",
  "marine traffic"
];

const ACCEPTANCE_FORBIDDEN_TITLE_TERMS = [
  "air traffic",
  "vessel traffic",
  "maritime",
  "marketing traffic",
  "web traffic",
  "network packet traffic",
  "bankruptcy"
];

const TITLE_DOMAIN_TERMS = [
  "traffic",
  "road",
  "highway",
  "freeway",
  "transportation",
  "mobility",
  "bus",
  "congestion",
  "travel time"
];

const TITLE_METHOD_TERMS = [
  "forecast",
  "forecasting",
  "predict",
  "prediction",
  "estimation",
  "reliability",
  "resilience",
  "control"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeDoi(doi) {
  if (!doi) return "";
  return String(doi)
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .trim();
}

function normalizeOpenAlexId(id) {
  if (!id) return "";
  return String(id).trim();
}

function normalizeSourceId(sourceId) {
  if (!sourceId) return "";
  return String(sourceId).split("/").pop();
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesNormalizedPhrase(haystack, phrase) {
  const normalizedHaystack = ` ${normalizeText(haystack)} `;
  const normalizedPhrase = ` ${normalizeText(phrase)} `;
  return normalizedHaystack.includes(normalizedPhrase);
}

function includesAllTerms(haystack, query) {
  const normalizedHaystack = ` ${normalizeText(haystack)} `;
  const terms = normalizeText(query).split(" ").filter(Boolean);
  return terms.every((term) => normalizedHaystack.includes(` ${term} `));
}

function hasAnyTerm(haystack, terms) {
  return terms.some((term) => includesNormalizedPhrase(haystack, term));
}

function reconstructAbstract(abstractInvertedIndex) {
  if (!abstractInvertedIndex || typeof abstractInvertedIndex !== "object") {
    return "";
  }

  const wordsByPosition = [];
  for (const [word, positions] of Object.entries(abstractInvertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      wordsByPosition[position] = word;
    }
  }

  return wordsByPosition.filter(Boolean).join(" ");
}

function workMatchesQuery(work, queryConfig) {
  const title = work.display_name ?? "";
  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const haystack = queryConfig.scope === "title" ? title : `${title} ${abstract}`;

  if (queryConfig.exact_phrase) {
    return includesNormalizedPhrase(haystack, queryConfig.query);
  }

  return includesAllTerms(haystack, queryConfig.query);
}

function findNonRoadReason(title) {
  const matched = NON_ROAD_MODE_TERMS.find((term) => includesNormalizedPhrase(title, term));
  return matched ? "NON_ROAD_MODE" : "";
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

function primaryTopicFromWork(work) {
  const topic = work.primary_topic ?? {};
  return {
    primary_topic: topic.display_name ?? "",
    subfield: topic.subfield?.display_name ?? ""
  };
}

function scoreWork(work, journalMeta, queryIds) {
  const title = work.title ?? "";
  const hasAbstract = Boolean(work.abstract_text);
  let score = 0;

  if (journalMeta.tier === "A") score += 3;
  if (journalMeta.tier === "B") score += 2;
  if (work.doi) score += 1;
  if (hasAbstract) score += 1;
  if (queryIds.length === 2) score += 1;
  if (queryIds.length >= 3) score += 2;
  if (hasAnyTerm(title, TITLE_DOMAIN_TERMS)) score += 2;
  if (hasAnyTerm(title, TITLE_METHOD_TERMS)) score += 2;

  return score;
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
      if (attempt < 3) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function makeCsv(works) {
  const columns = [
    "rank",
    "score",
    "publication_date",
    "title",
    "journal",
    "doi",
    "openalex_id",
    "query_ids",
    "matched_query_count",
    "primary_topic",
    "subfield",
    "oa_status"
  ];

  const rows = works.map((work, index) => ({
    rank: index + 1,
    score: work.score,
    publication_date: work.publication_date,
    title: work.title,
    journal: work.journal,
    doi: work.doi,
    openalex_id: work.openalex_id,
    query_ids: work.query_ids.join(";"),
    matched_query_count: work.matched_query_count,
    primary_topic: work.primary_topic,
    subfield: work.subfield,
    oa_status: work.oa_status
  }));

  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  ].join("\n");
}

function tableRow(values) {
  return `| ${values.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ")} |`;
}

function makeMarkdown(audit) {
  const stats = audit.query_statistics;
  const zeroResultQueries = stats.filter((item) => item.filtered_count === 0);
  const nonRoadRecords = audit.non_road_removed_records;
  const topWorks = audit.works.slice(0, 50);
  const topContributors = [...stats]
    .sort((a, b) => b.unique_contribution - a.unique_contribution || a.id.localeCompare(b.id))
    .slice(0, 10);
  const duplicateLeader = [...stats]
    .filter((item) => item.filtered_count > 0)
    .sort((a, b) => b.duplicate_rate - a.duplicate_rate || b.duplicates_in_query - a.duplicates_in_query)[0];

  const lines = [];
  lines.push("# OpenAlex Transportation Search Batch Audit v1.0");
  lines.push("");
  lines.push(`Generated at: ${audit.generated_at}`);
  lines.push(`Date window: ${audit.date_window.from} to ${audit.date_window.to}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total queries: ${stats.length}`);
  lines.push(`- Queries successful: ${stats.filter((item) => item.status === "success").length}`);
  lines.push(`- Queries failed: ${audit.failed_queries.length}`);
  lines.push(`- Raw works: ${audit.raw_count}`);
  lines.push(`- Filtered works: ${audit.filtered_count}`);
  lines.push(`- Unique works: ${audit.unique_count}`);
  lines.push(`- Duplicates removed: ${audit.duplicates_removed}`);
  lines.push(`- NON_ROAD_MODE removed: ${audit.non_road_removed}`);
  lines.push(`- Final unique candidates: ${audit.unique_count}`);
  lines.push("");
  lines.push("No JCR quartile is inferred or claimed in this audit.");
  lines.push("");
  lines.push("## Query Statistics");
  lines.push("");
  lines.push(tableRow(["query_id", "group", "raw", "filtered", "unique contribution", "precision"]));
  lines.push(tableRow(["---", "---", "---:", "---:", "---:", "---"]));
  for (const item of stats) {
    lines.push(tableRow([item.id, item.group, item.raw_count, item.filtered_count, item.unique_contribution, "NEEDS_REVIEW"]));
  }
  lines.push("");
  lines.push("## Zero-result Queries");
  lines.push("");
  if (zeroResultQueries.length === 0) {
    lines.push("None.");
  } else {
    lines.push(zeroResultQueries.map((item) => `- ${item.id}: ${item.query}`).join("\n"));
  }
  lines.push("");
  lines.push("## Duplicate Review");
  lines.push("");
  if (duplicateLeader) {
    lines.push(
      `Highest duplicate-rate query: ${duplicateLeader.id} (${duplicateLeader.duplicate_rate.toFixed(2)}; ` +
        `${duplicateLeader.duplicates_in_query}/${duplicateLeader.filtered_count}).`
    );
  } else {
    lines.push("Highest duplicate-rate query: none.");
  }
  lines.push("");
  lines.push("## Top Contributing Queries");
  lines.push("");
  lines.push(tableRow(["query_id", "query", "unique contribution"]));
  lines.push(tableRow(["---", "---", "---:"]));
  for (const item of topContributors) {
    lines.push(tableRow([item.id, item.query, item.unique_contribution]));
  }
  lines.push("");
  lines.push("## NON_ROAD_MODE Deletions");
  lines.push("");
  if (nonRoadRecords.length === 0) {
    lines.push("None.");
  } else {
    lines.push(tableRow(["query_id", "title", "journal", "openalex_id", "removed_reason"]));
    lines.push(tableRow(["---", "---", "---", "---", "---"]));
    for (const record of nonRoadRecords) {
      lines.push(tableRow([record.query_id, record.title, record.journal, record.openalex_id, record.removed_reason]));
    }
  }
  lines.push("");
  lines.push("## Top 50 Papers");
  lines.push("");
  lines.push(tableRow(["rank", "score", "date", "title", "journal", "doi", "query_ids"]));
  lines.push(tableRow(["---:", "---:", "---", "---", "---", "---", "---"]));
  for (const [index, work] of topWorks.entries()) {
    lines.push(tableRow([index + 1, work.score, work.publication_date, work.title, work.journal, work.doi, work.query_ids.join(";")]));
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
  if (audit.failed_queries.length === 0) {
    lines.push("None.");
  } else {
    for (const failed of audit.failed_queries) {
      lines.push(`- ${failed.id}: ${failed.error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function makeValidation(works, sourceIds) {
  const checks = [];
  const forbiddenMatches = works
    .filter((work) => ACCEPTANCE_FORBIDDEN_TITLE_TERMS.some((term) => includesNormalizedPhrase(work.title, term)))
    .map((work) => `${work.openalex_id}: ${work.title}`);

  checks.push({
    name: "forbidden_title_terms",
    status: forbiddenMatches.length === 0 ? "PASS" : "FAIL",
    details: forbiddenMatches.length === 0 ? "" : forbiddenMatches.join("; ")
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
  for (const work of works) {
    idCounts.set(work.openalex_id, (idCounts.get(work.openalex_id) ?? 0) + 1);
  }
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

  checks.push({
    name: "non_empty_outputs",
    status: works.length > 0 ? "PASS" : "FAIL",
    details: works.length > 0 ? "" : "No unique works were produced."
  });

  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    checks
  };
}

async function main() {
  await mkdir(AUDIT_DIR, { recursive: true });

  const journals = JSON.parse(await readFile(path.join(CONFIG_DIR, "journals_target.json"), "utf8"));
  const queries = JSON.parse(await readFile(path.join(CONFIG_DIR, "search_queries.json"), "utf8"));
  const journalBySourceId = new Map(journals.map((journal) => [journal.source_id, journal]));
  const sourceIds = journals.map((journal) => journal.source_id);

  const headers = {
    "User-Agent": "traffic-q1-daily-wecom OpenAlex batch audit"
  };
  if (process.env.OPENALEX_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENALEX_API_KEY}`;
  }

  const queryStatistics = [];
  const failedQueries = [];
  const allKeptHits = [];
  const nonRoadRemovedRecords = [];
  let rawCount = 0;
  let localMatchedCount = 0;

  for (const queryConfig of queries) {
    const url = buildOpenAlexUrl(queryConfig, sourceIds);
    const stat = {
      id: queryConfig.id,
      group: queryConfig.group,
      query: queryConfig.query,
      scope: queryConfig.scope,
      exact_phrase: Boolean(queryConfig.exact_phrase),
      status: "success",
      raw_count: 0,
      local_match_count: 0,
      filtered_count: 0,
      non_road_removed: 0,
      unique_contribution: 0,
      duplicates_in_query: 0,
      duplicate_rate: 0
    };

    try {
      const payload = await fetchJsonWithRetry(url, headers);
      const results = Array.isArray(payload.results) ? payload.results : [];
      stat.raw_count = results.length;
      rawCount += results.length;

      for (const work of results) {
        if (!workMatchesQuery(work, queryConfig)) continue;
        localMatchedCount += 1;
        stat.local_match_count += 1;

        const title = work.display_name ?? "";
        const removedReason = findNonRoadReason(title);
        const journalMeta = journalFromWork(work, journalBySourceId);
        if (removedReason) {
          stat.non_road_removed += 1;
          nonRoadRemovedRecords.push({
            query_id: queryConfig.id,
            openalex_id: normalizeOpenAlexId(work.id),
            doi: normalizeDoi(work.doi),
            title,
            journal: journalMeta.journal,
            source_id: journalMeta.source_id,
            removed_reason: removedReason
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

    if (!uniqueByKey.has(dedupeKey)) {
      const journalMeta = journalFromWork(work, journalBySourceId);
      const topic = primaryTopicFromWork(work);
      const abstractText = reconstructAbstract(work.abstract_inverted_index);
      uniqueByKey.set(dedupeKey, {
        openalex_id: openalexId,
        doi,
        title: work.display_name ?? "",
        publication_date: work.publication_date ?? "",
        journal: journalMeta.journal,
        source_id: journalMeta.source_id,
        tier: journalMeta.tier,
        query_ids: [],
        matched_query_count: 0,
        primary_topic: topic.primary_topic,
        subfield: topic.subfield,
        oa_status: work.open_access?.oa_status ?? "",
        abstract_text: abstractText
      });
    }

    const uniqueWork = uniqueByKey.get(dedupeKey);
    if (!uniqueWork.query_ids.includes(hit.query_id)) {
      uniqueWork.query_ids.push(hit.query_id);
      uniqueWork.matched_query_count = uniqueWork.query_ids.length;
    }

    if (!seenKeys.has(dedupeKey)) {
      seenKeys.add(dedupeKey);
      queryStatById.get(hit.query_id).unique_contribution += 1;
    }
  }

  const works = [...uniqueByKey.values()]
    .map((work) => ({
      openalex_id: work.openalex_id,
      doi: work.doi,
      title: work.title,
      publication_date: work.publication_date,
      journal: work.journal,
      source_id: work.source_id,
      query_ids: work.query_ids.sort(),
      matched_query_count: work.matched_query_count,
      primary_topic: work.primary_topic,
      subfield: work.subfield,
      oa_status: work.oa_status,
      score: scoreWork(work, { tier: work.tier }, work.query_ids)
    }))
    .sort((a, b) => b.score - a.score || b.matched_query_count - a.matched_query_count || b.publication_date.localeCompare(a.publication_date) || a.title.localeCompare(b.title));

  for (const stat of queryStatistics) {
    stat.duplicates_in_query = Math.max(0, stat.filtered_count - stat.unique_contribution);
    stat.duplicate_rate = stat.filtered_count > 0 ? stat.duplicates_in_query / stat.filtered_count : 0;
  }

  const filteredCount = allKeptHits.length;
  const audit = {
    generated_at: new Date().toISOString(),
    date_window: {
      from: START_DATE,
      to: END_DATE
    },
    query_statistics: queryStatistics,
    failed_queries: failedQueries,
    raw_count: rawCount,
    local_matched_count: localMatchedCount,
    filtered_count: filteredCount,
    unique_count: works.length,
    duplicates_removed: filteredCount - works.length,
    non_road_removed: nonRoadRemovedRecords.length,
    non_road_removed_records: nonRoadRemovedRecords,
    works
  };

  audit.validation = makeValidation(works, sourceIds);

  await writeFile(OUTPUT_JSON, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_CSV, `${makeCsv(works)}\n`, "utf8");
  await writeFile(OUTPUT_MD, makeMarkdown(audit), "utf8");

  console.log("OPENALEX BATCH AUDIT");
  console.log(`Queries tested: ${queries.length}`);
  console.log(`Queries successful: ${queryStatistics.filter((item) => item.status === "success").length}`);
  console.log(`Queries failed: ${failedQueries.length}`);
  console.log(`Raw works: ${audit.raw_count}`);
  console.log(`Filtered works: ${audit.filtered_count}`);
  console.log(`Unique works: ${audit.unique_count}`);
  console.log(`Duplicates removed: ${audit.duplicates_removed}`);
  console.log(`Non-road-mode removed: ${audit.non_road_removed}`);
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
