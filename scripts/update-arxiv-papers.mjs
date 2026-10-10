#!/usr/bin/env node
/**
 * Turn arXiv preprint entries in src/data/papers.bib into the published paper.
 *
 * Usage:  npm run bib:arxiv            dry-run: report what would change
 *         npm run bib:arxiv -- --write rewrite the entries in place
 *         npm run bib:arxiv -- -f path.bib   use a different .bib file
 *
 * An entry counts as a preprint when its DOI is an arXiv DOI (10.48550/arXiv.*).
 * For each one the arXiv API gives the author's comment, the journal reference and
 * the DOI of the published version. The published DOI is that arXiv `doi` field, or
 * else a Crossref title match that is not an arXiv DOI. With one, the entry is
 * rewritten from Crossref (venue, pages, publisher, DOI, badge); key, authors, title
 * and google_scholar_id stay. Without one, a comment such as "accepted at ..." or a
 * journal reference is only reported: no DOI means no published record to copy from.
 *
 * Exit code: 0 nothing to do, 1 something found (also after --write), 2 arXiv down.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  BIB_FILE,
  USER_AGENT,
  arxivIdFromDoi,
  badgeFor,
  crossrefFields,
  crossrefRequest,
  decodeEntities,
  formatEntry,
  parseEntries,
  printHeaderHelp,
  searchCrossref,
  sleep,
  texEscape,
  unescapeDoi,
} from './lib/missing-papers.mjs';

const ARXIV_DOI = /^10\.48550\//i;
const ACCEPTED = /\b(accepted|to appear|camera[- ]ready|will appear|published (?:in|at))\b/i;
// Fields the published record replaces; everything else on the entry is kept.
const REPLACED = [
  'institution',
  'doi',
  'journal',
  'booktitle',
  'publisher',
  'volume',
  'number',
  'pages',
  'isbn',
  'issn',
  'month',
  'url',
  'type',
  'location',
  'abbr',
];

const { values: options } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    file: { type: 'string', short: 'f', default: BIB_FILE },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (options.help) {
  printHeaderHelp(import.meta.url);
  process.exit(0);
}

const tag = (xml, name) =>
  decodeEntities(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();

async function arxivRecord(id) {
  const response = await fetch(`https://export.arxiv.org/api/query?id_list=${id}`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const entry = (await response.text()).match(/<entry>[\s\S]*?<\/entry>/)?.[0] ?? '';
  return {
    comment: tag(entry, 'arxiv:comment'),
    journalRef: tag(entry, 'arxiv:journal_ref'),
    doi: tag(entry, 'arxiv:doi'),
  };
}

/** The Crossref record of the published version, or null. */
async function publishedRecord(entry, record) {
  const candidates = [];
  if (record.doi && !ARXIV_DOI.test(record.doi)) candidates.push(record.doi);
  for (const doi of candidates) {
    const message = await crossrefRequest(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    );
    if (message) return message;
  }
  const found = await searchCrossref(entry.fields.title.replaceAll(/[{}]/g, ''));
  // A title alone can match another paper: the first author must agree as well.
  const surname = normalize(entry.fields.author.split(/\s+and\s+/)[0].split(',')[0]);
  const sameAuthor = found?.author?.some((author) => normalize(author.family ?? '') === surname);
  return found && sameAuthor && !ARXIV_DOI.test(found.DOI ?? '') ? found : null;
}

function rewrite(entry, message) {
  const type = { 'journal-article': 'article', 'proceedings-article': 'inproceedings' }[
    message.type
  ];
  if (!type) return null;
  const kept = Object.fromEntries(
    Object.entries(entry.fields).filter(([name]) => !REPLACED.includes(name)),
  );
  const fields = { ...kept };
  for (const [name, value] of Object.entries(crossrefFields(message, type, type === 'article'))) {
    fields[name] = texEscape(value);
  }
  fields.doi = texEscape(message.DOI.toLowerCase());
  const place = message.event?.location?.replaceAll(/\s+,/g, ',').trim();
  if (place) fields.location = texEscape(place);
  const abbr = badgeFor(fields);
  if (abbr) fields.abbr = abbr;
  return formatEntry(type, entry.key, fields);
}

let text = readFileSync(options.file, 'utf8');
const found = [];
const entries = parseEntries(text).filter((entry) =>
  arxivIdFromDoi(unescapeDoi(entry.fields.doi ?? '')),
);
console.log(`${entries.length} arXiv preprint entries.`);

for (const entry of entries.toReversed()) {
  const id = arxivIdFromDoi(unescapeDoi(entry.fields.doi));
  let record;
  try {
    record = await arxivRecord(id);
    const message = await publishedRecord(entry, record);
    await sleep(3000); // arXiv asks for one request every 3 seconds
    const updated = message ? rewrite(entry, message) : null;
    if (updated) {
      console.log(`\n[${entry.key}] arXiv:${id} -> ${message.DOI}\n${updated}`);
      text = text.slice(0, entry.start) + updated + text.slice(entry.end);
      found.push(entry.key);
    } else if (record.journalRef || ACCEPTED.test(record.comment)) {
      console.log(
        `\n[${entry.key}] arXiv:${id} looks accepted or published but has no DOI yet:\n` +
          `  comment:     ${record.comment || '-'}\n  journal_ref: ${record.journalRef || '-'}`,
      );
      found.push(entry.key);
    }
  } catch (error) {
    console.error(`arXiv or Crossref unreachable (${error.message}); no file changed.`);
    process.exit(2);
  }
}

if (options.write && text !== readFileSync(options.file, 'utf8')) writeFileSync(options.file, text);
if (!found.length) console.log('Every preprint is still a preprint.');
process.exit(found.length ? 1 : 0);
