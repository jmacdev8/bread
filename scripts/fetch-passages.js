#!/usr/bin/env node
//
// Fetches all Bible passages from API.Bible and saves them as JSON files.
//
// Usage:
//   1. Sign up at https://scripture.api.bible and get a free API key
//   2. Run: API_BIBLE_KEY=your-key-here node scripts/fetch-passages.js
//
// This reads the reading plan from the CSV and fetches each passage
// from the NIV Bible via API.Bible, saving to public/passages/YYYY-MM-DD.json
//

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_BIBLE_KEY;
if (!API_KEY) {
  console.error('Missing API_BIBLE_KEY environment variable.');
  console.error('Usage: API_BIBLE_KEY=your-key node scripts/fetch-passages.js');
  process.exit(1);
}

// Bible IDs on API.Bible
const BIBLE_IDS = {
  niv: '78a9f6124f344018-01',
  msg: '6f11a7de016f942e-01',
};

const TRANSLATION = (process.argv[2] || 'niv').toLowerCase();
if (!BIBLE_IDS[TRANSLATION]) {
  console.error(`Unknown translation: "${TRANSLATION}". Available: ${Object.keys(BIBLE_IDS).join(', ')}`);
  process.exit(1);
}

const BIBLE_ID = BIBLE_IDS[TRANSLATION];
const BASE_URL = `https://rest.api.bible/v1/bibles/${BIBLE_ID}`;

const CSV_PATH = path.join(__dirname, '..', 'BREAD_2026_Reading_Plan.csv');
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'passages', TRANSLATION);

// Book name -> API.Bible book ID mapping
const BOOK_IDS = {
  'Genesis': 'GEN', 'Exodus': 'EXO', 'Leviticus': 'LEV', 'Numbers': 'NUM',
  'Deuteronomy': 'DEU', 'Joshua': 'JOS', 'Judges': 'JDG', 'Ruth': 'RUT',
  '1 Samuel': '1SA', '2 Samuel': '2SA', '1 Kings': '1KI', '2 Kings': '2KI',
  '1 Chronicles': '1CH', '2 Chronicles': '2CH', 'Ezra': 'EZR', 'Nehemiah': 'NEH',
  'Esther': 'EST', 'Job': 'JOB', 'Psalm': 'PSA', 'Proverbs': 'PRO',
  'Ecclesiastes': 'ECC', 'Song of Solomon': 'SNG', 'Isaiah': 'ISA', 'Jeremiah': 'JER',
  'Lamentations': 'LAM', 'Ezekiel': 'EZK', 'Daniel': 'DAN', 'Hosea': 'HOS',
  'Joel': 'JOL', 'Amos': 'AMO', 'Obadiah': 'OBA', 'Jonah': 'JON', 'Micah': 'MIC',
  'Nahum': 'NAM', 'Habakkuk': 'HAB', 'Zephaniah': 'ZEP', 'Haggai': 'HAG',
  'Zechariah': 'ZEC', 'Malachi': 'MAL',
  'Matthew': 'MAT', 'Mark': 'MRK', 'Luke': 'LUK', 'John': 'JHN',
  'Acts': 'ACT', 'Romans': 'ROM', '1 Corinthians': '1CO', '2 Corinthians': '2CO',
  'Galatians': 'GAL', 'Ephesians': 'EPH', 'Philippians': 'PHP', 'Colossians': 'COL',
  '1 Thessalonians': '1TH', '2 Thessalonians': '2TH', '1 Timothy': '1TI', '2 Timothy': '2TI',
  'Titus': 'TIT', 'Philemon': 'PHM', 'Hebrews': 'HEB', 'James': 'JAS',
  '1 Peter': '1PE', '2 Peter': '2PE', '1 John': '1JN', '2 John': '2JN', '3 John': '3JN',
  'Jude': 'JUD', 'Revelation': 'REV'
};

// Parse "Psalm 32" or "1 Corinthians 3:10-17" or "John 9:1-12, 35-41" into API.Bible passage ID(s)
function parsePassageRef(ref) {
  // Handle multi-range passages like "John 9:1-12, 35-41"
  // We'll fetch the full range from first verse to last verse
  const commaMatch = ref.match(/^(.+?)\s+(\d+):(\d+)-(\d+),\s*(\d+)-(\d+)$/);
  if (commaMatch) {
    const [, book, chapter, startVerse, , , endVerse] = commaMatch;
    const bookId = BOOK_IDS[book];
    if (!bookId) return null;
    return `${bookId}.${chapter}.${startVerse}-${bookId}.${chapter}.${endVerse}`;
  }

  // "Book Chapter:Start-End" e.g., "Romans 8:1-17"
  const rangeMatch = ref.match(/^(.+?)\s+(\d+):(\d+)-(\d+)$/);
  if (rangeMatch) {
    const [, book, chapter, startVerse, endVerse] = rangeMatch;
    const bookId = BOOK_IDS[book];
    if (!bookId) return null;
    return `${bookId}.${chapter}.${startVerse}-${bookId}.${chapter}.${endVerse}`;
  }

  // "Book Chapter" (whole chapter) e.g., "Psalm 32"
  const chapterMatch = ref.match(/^(.+?)\s+(\d+)$/);
  if (chapterMatch) {
    const [, book, chapter] = chapterMatch;
    const bookId = BOOK_IDS[book];
    if (!bookId) return null;
    return `${bookId}.${chapter}`;
  }

  // "Book StartChapter:StartVerse-EndChapter:EndVerse" - cross-chapter (unlikely but handle)
  // "Philemon 1-25" (whole book, single chapter)
  const singleChapterRange = ref.match(/^(.+?)\s+(\d+)-(\d+)$/);
  if (singleChapterRange) {
    const [, book, start, end] = singleChapterRange;
    const bookId = BOOK_IDS[book];
    if (!bookId) return null;
    // Could be chapter range or verse range in chapter 1
    // For books like Philemon, Jude, etc., treat as verses in chapter 1
    const singleChapterBooks = ['Philemon', 'Jude', 'Obadiah', '2 John', '3 John'];
    if (singleChapterBooks.includes(book)) {
      return `${bookId}.1.${start}-${bookId}.1.${end}`;
    }
    // Otherwise treat as chapter range - just fetch first chapter for now
    return `${bookId}.${start}`;
  }

  // "Book Chapter:Verse-Chapter:Verse" cross-chapter range like "Matthew 9:35-10:15"
  const crossChapterMatch = ref.match(/^(.+?)\s+(\d+):(\d+)-(\d+):(\d+)$/);
  if (crossChapterMatch) {
    const [, book, startCh, startV, endCh, endV] = crossChapterMatch;
    const bookId = BOOK_IDS[book];
    if (!bookId) return null;
    return `${bookId}.${startCh}.${startV}-${bookId}.${endCh}.${endV}`;
  }

  console.warn(`  Could not parse passage reference: "${ref}"`);
  return null;
}

// Fetch a passage from API.Bible
async function fetchPassage(passageId) {
  const url = `${BASE_URL}/passages/${passageId}?content-type=html&include-verse-numbers=true&include-titles=false&include-notes=false`;
  const res = await fetch(url, {
    headers: { 'api-key': API_KEY }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { content: data.data.content, copyright: data.data.copyright };
}

// Clean up the HTML from API.Bible into our format
function cleanHtml(html) {
  let text = html;

  // Remove psalm/chapter title lines (class="cl")
  text = text.replace(/<p[^>]*class="cl"[^>]*>.*?<\/p>/gi, '');

  // Convert verse number spans to <sup> format
  // API.Bible uses: <span data-number="1" ... class="v">1</span>
  text = text.replace(/<span[^>]*data-number="(\d+)"[^>]*class="[^"]*v[^"]*"[^>]*>\d+<\/span>/gi, '<sup>$1</sup>');

  // Remove <span class="nd"> (used for "Lord" in small caps) but keep content
  text = text.replace(/<span[^>]*class="nd"[^>]*>(.*?)<\/span>/gi, '$1');

  // Remove all other spans but keep content
  text = text.replace(/<span[^>]*>/gi, '');
  text = text.replace(/<\/span>/gi, '');

  // Preserve paragraph structure: strip attributes but keep <p> tags
  text = text.replace(/<p[^>]*>/gi, '<p>');

  // Remove any remaining HTML tags except <sup> and <p>
  text = text.replace(/<(?!\/?sup)(?!\/?p)[^>]+>/gi, ' ');

  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

async function main() {
  // Read CSV
  const csv = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = csv.trim().split('\n').slice(1); // skip header

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let fetched = 0;
  let skipped = 0;
  let errors = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Parse CSV (handle quoted fields for passages with commas)
    const match = line.match(/^(\d{4}-\d{2}-\d{2}),([^,]+),([^,]+),(.+)$/);
    if (!match) {
      console.warn(`Skipping malformed line: ${line}`);
      continue;
    }

    const [, date, , , rawPassage] = match;
    const passage = rawPassage.replace(/^"|"$/g, '').trim();
    const outFile = path.join(OUTPUT_DIR, `${date}.json`);

    // Skip if already fetched
    if (fs.existsSync(outFile)) {
      skipped++;
      continue;
    }

    const passageId = parsePassageRef(passage);
    if (!passageId) {
      console.warn(`  Skipping ${date}: could not parse "${passage}"`);
      errors++;
      continue;
    }

    try {
      console.log(`Fetching ${date}: ${passage} (${passageId})...`);
      const { content, copyright } = await fetchPassage(passageId);
      const verses = cleanHtml(content);

      fs.writeFileSync(outFile, JSON.stringify({ verses, copyright }, null, 2));
      fetched++;

      // Rate limit: ~2 requests per second to be safe
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  Error fetching ${date} (${passage}): ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone! Fetched: ${fetched}, Skipped (already exists): ${skipped}, Errors: ${errors}`);
}

main();
