#!/usr/bin/env node
/**
 * Find papers the author has published that src/data/papers.bib does not list yet,
 * using KITopen (the KIT publication repository) as the only source.
 *
 * Usage:  npm run bib:missing:kitopen                dry-run: print proposed entries
 *         npm run bib:missing:kitopen -- -i          ask per entry: add / skip / ignore / quit
 *         npm run bib:missing:kitopen -- --yes       add every proposed entry
 *         npm run bib:missing:kitopen -- -f path.bib use a different .bib file
 *         npm run bib:missing:kitopen -- --only article,inproceedings   propose only these entry types
 *
 * The KITopen person is looked up by `orcid_id` in src/data/socials.yml on every run,
 * then the person's publication list is fetched as CSL-JSON with the request the KITopen
 * list UI sends (author roles only, no research data, so no supervised theses or
 * replication packages). Reports duplicating a published item are dropped. KITopen's
 * metadata wins; Crossref only fills gaps. There is no fallback: when KITopen cannot
 * be reached the script says so and exits 2 without touching any file.
 *
 * Matching, entry style, the ignore list (ids are `kitopen:<record id>`),
 * `google_scholar_id` lookup and insertion are shared with find-missing-papers.mjs
 * (see scripts/lib/missing-papers.mjs).
 *
 * Exit code: 0 when nothing is missing, 1 when something is missing (also after adding
 * it, so the dry-run works as a check), 2 when KITopen could not be used.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  BIB_FILE,
  SOCIALS_FILE,
  SourceUnavailable,
  USER_AGENT,
  arxivIdFromDoi,
  loadYaml,
  normalize,
  sameTitle,
  printHeaderHelp,
  proposeMissingPapers,
} from './lib/missing-papers.mjs';

const KITOPEN_BASE = 'https://publikationen.bibliothek.kit.edu/publikationslisten';
// The two lists below are what the KITopen list UI sends for an author's own works; the
// server then does the filtering (no supervised theses, no research data).
// Contributor roles that count as authorship (KITopen organization/role ids); the
// supervisor role is not among them, so supervised theses never come back.
const AUTHOR_ROLE_IDS = ['1000.105', '1008.105', '1011.105', '1012.105'];
// Publication types asked for: everything except research data (datasets, software).
const PUBLICATION_TYPES = [
  'BUCHAUFSATZ',
  'BUCH',
  'HABILITATION',
  'DISSERTATION',
  'DIPLOM',
  'MAGISTER',
  'MASTER',
  'BACHELOR',
  'STUDIENARBEIT',
  'ZEITSCHRIFTENAUFSATZ',
  'ZEITSCHRIFTENBAND',
  'PROCEEDINGSBEITRAG',
  'PROCEEDINGSBAND',
  'FORSCHUNGSBERICHT',
  'VORTRAG',
  'POSTER',
  'REZENSION_BUCH',
  'REZENSION_ZEITSCHRIFT',
  'WISSKOMM_INTERNET',
  'AUDIO_VIDEO',
  'BILD',
  'LEHRMATERIALIEN',
  'SONSTIGES',
];
// KITopen record types worth proposing, mapped to the BibTeX type papers.bib uses.
const ENTRY_TYPES = {
  'paper-conference': 'inproceedings',
  'article-journal': 'article',
  report: 'techreport',
};
// KITopen's German thesis genres, mapped to papers.bib's entry type and `type` text.
const THESIS_KINDS = {
  Bachelorarbeit: { entryType: 'thesis', type: "Bachelor's Thesis" },
  Masterarbeit: { entryType: 'masterthesis', type: "Master's Thesis" },
  Studienarbeit: { entryType: 'thesis', type: 'Study Thesis' },
};

async function kitopenRequest(url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, ...init.headers },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new SourceUnavailable(`KITopen request failed: ${error.message}`);
  }
  if (!response.ok) throw new SourceUnavailable(`KITopen answered HTTP ${response.status}`);
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new SourceUnavailable('KITopen did not answer with JSON');
  }
}

/** KITopen's person id (e.g. "p6981.105") for an ORCID. */
async function findKitopenPerson(orcid) {
  const matches = await kitopenRequest(
    `${KITOPEN_BASE}/api.php/get_descriptions?entity=vv_person&query=${encodeURIComponent(orcid)}&lang=de`,
  );
  const person = Array.isArray(matches) ? matches.find((match) => match.tid) : null;
  if (!person) throw new SourceUnavailable(`no KITopen person found for ORCID ${orcid}`);
  return person.tid;
}

function toPublication(item) {
  const dateParts = item.issued?.['date-parts']?.[0] ?? [];
  const thesisKind = item.type === 'thesis' ? THESIS_KINDS[item.genre] : null;
  const entryType = thesisKind?.entryType ?? ENTRY_TYPES[item.type] ?? 'thesis';
  const doi = item.DOI?.toLowerCase() ?? null;
  const publication = {
    sourceId: `kitopen:${item['kit-publication-id']}`,
    title: item.title.replace(/\s+/g, ' ').trim(),
    authors: item.author.map((author) => `${author.given ?? ''} ${author.family}`.trim()),
    year: dateParts[0] ? String(dateParts[0]) : null,
    venue: item['container-title'] ?? null,
    volume: item.volume ?? null,
    number: item.issue ?? item.number ?? null,
    pages: item.page ?? null,
    school: null,
    doi,
    arxivId: arxivIdFromDoi(doi),
    preprint: false,
    entryType,
    sourcePriority: true,
    extraFields: {
      month: dateParts[1] ? String(Number(dateParts[1])) : '',
      isbn: item.ISBN?.replaceAll('-', '') ?? '',
      issn: item.ISSN?.split(',')[0].trim() ?? '',
      series: item['collection-title'] ?? '',
      pagetotal: item['number-of-pages'] ? String(item['number-of-pages']) : '',
    },
  };
  if (entryType === 'inproceedings' || entryType === 'article') {
    publication.extraFields.publisher = item.publisher ?? '';
  } else if (entryType === 'techreport') {
    publication.extraFields.institution = item.publisher ? `{${item.publisher}}` : '';
  } else {
    publication.school = item.publisher ?? null;
    publication.extraFields.type = thesisKind?.type ?? item.genre ?? '';
  }
  return publication;
}

/** Fetch the person's list; returns {publications, totalCount, typeCounts, reportDuplicateCount}. */
async function fetchKitopenPublications(orcid) {
  if (!orcid) throw new SourceUnavailable(`no 'orcid_id' in ${SOCIALS_FILE}`);
  const personId = await findKitopenPerson(orcid);
  // The same POST shape the KITopen list UI sends, with our person as contributor.
  const items = await kitopenRequest(`${KITOPEN_BASE}/get.php`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      referencing: 'all',
      external_publications: 'all',
      lang: 'de',
      format: 'csl_json',
      style: 'kit-3lines-title_b-authors-other',
      consider_suborganizations: 'true',
      updatecache: '',
      contributors: JSON.stringify([[AUTHOR_ROLE_IDS, [personId]]]),
      types: PUBLICATION_TYPES.join(','),
    }),
  });
  if (!Array.isArray(items)) throw new SourceUnavailable('KITopen returned no publication list');

  const typeCounts = {};
  const publications = [];
  for (const item of items) {
    typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
    // Cheap sanity filter; the server-side lists above already excluded the rest.
    if (item.author?.length && item.title) publications.push(toPublication(item));
  }

  // A `report` is often the KITopen copy of a paper published elsewhere in this list:
  // like a preprint, it is redundant once a non-report item has the same title.
  const publishedTitles = items
    .filter((item) => item.type !== 'report' && item.title)
    .map((item) => normalize(item.title));
  const reportDuplicates = new Set(
    publications.filter(
      (publication) =>
        publication.entryType === 'techreport' &&
        publishedTitles.some((published) => sameTitle(normalize(publication.title), published)),
    ),
  );
  return {
    publications: publications.filter((publication) => !reportDuplicates.has(publication)),
    totalCount: items.length,
    typeCounts,
    reportDuplicateCount: reportDuplicates.size,
  };
}

async function main() {
  const { values: options } = parseArgs({
    options: {
      file: { type: 'string', short: 'f', default: BIB_FILE },
      interactive: { type: 'boolean', short: 'i', default: false },
      yes: { type: 'boolean', default: false },
      delay: { type: 'string', default: '0.5' },
      only: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (options.help) {
    printHeaderHelp(import.meta.url);
    return 0;
  }

  const only = options.only ? new Set(options.only.split(',')) : null;
  const socials = loadYaml(SOCIALS_FILE) ?? {};
  let fetched;
  try {
    fetched = await fetchKitopenPublications(socials.orcid_id);
  } catch (error) {
    if (!(error instanceof SourceUnavailable)) throw error;
    console.error(`Could not use KITopen: ${error.message}. ${options.file} left unchanged.`);
    return 2;
  }
  const types = Object.entries(fetched.typeCounts)
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
  console.log(
    `KITopen: ${fetched.totalCount} items (${types}); dropped ${fetched.reportDuplicateCount} ` +
      'reports that duplicate a published item.',
  );

  return proposeMissingPapers({
    publications: only
      ? fetched.publications.filter((publication) => only.has(publication.entryType))
      : fetched.publications,
    sourceName: 'kitopen',
    bibFile: options.file,
    bibText: readFileSync(options.file, 'utf8'),
    interactive: options.interactive,
    yes: options.yes,
    delaySeconds: Number(options.delay),
  });
}

process.exitCode = await main();
