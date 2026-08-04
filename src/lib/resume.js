/**
 * Resume parsing — runs entirely in the browser.
 * PDF text extraction uses pdf.js; .txt/.md are read directly.
 * The resume never leaves the user's machine (except in optional Smart-rank
 * mode, where the full text is sent to the Anthropic API — see src/lib/ai.js).
 */
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractResumeText(file) {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Preserve LINE structure, not just page structure. Joining every item
      // with spaces flattens the whole page into one line, so downstream
      // "bigrams can't cross line breaks" protection never fires and phrases
      // glue across unrelated lines ("...Data Science" + "Princeton..." →
      // "science princeton"). pdf.js marks line ends with hasEOL; the
      // y-coordinate check (transform[5]) is a fallback for PDFs that don't.
      let lastY = null;
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (
          lastY !== null &&
          y !== undefined &&
          Math.abs(y - lastY) > 2 &&
          !text.endsWith("\n")
        ) {
          text += "\n";
        }
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
        if (y !== undefined) lastY = y;
      }
      text += "\n";
    }
    return text;
  }
  return file.text();
}

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have i if in into is it its of on or our so than that the their there these this to was we were which while will with you your not no nor over under across per via etc more most other such own same too very can just also both each few how all any been being do does did doing down during before after above below again further then once here when where why what who whom am s t don should now`.split(
    " "
  )
);

// Generic resume words that match every job description and add noise. Includes
// month names + abbreviations and contact/eligibility boilerplate that would
// otherwise surface as "keywords".
const NOISE = new Set(
  `experience work team teams role company companies year years month months responsibilities skills including led built managed developed strong new key drive support ability work working email phone linkedin github university college bachelor master degree gpa january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec present current resident permanent citizen citizenship visa authorized authorization references cum laude summa magna used using use utilized leveraged end ends expert experts proficient proficiency familiar familiarity knowledge various multiple several ensure ensured ensuring created creating designed designing improved improving delivered delivering b.s b.s. m.s m.s. a.b a.b. b.a b.a. m.a m.a. ph.d ph.d. phd bs ms ba ma msc bsc mba certificate certifications coursework minor major honors deans dean's`.split(
    " "
  )
);

// A token is "digit-heavy" when more than a third of its characters are digits.
// Kills years/dates/zips ("2024", "07960") while keeping "b2b" and "gpt-4".
const digitHeavy = (t) => {
  const d = (t.match(/\d/g) || []).length;
  return d * 3 > t.length;
};

// (a) Strip contact info and dates from the raw text BEFORE tokenizing so their
// fragments never become candidate keywords.
const preClean = (text) =>
  (text || "")
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, " ") // emails
    .replace(/\bhttps?:\/\/\S+/gi, " ") // urls
    .replace(/\bwww\.\S+/gi, " ") // bare www urls
    .replace(/\b(?:linkedin|github)\b[\s:/]*[\w./-]*/gi, " ") // handles
    .replace(/\b[\w.-]+\.(?:com|net|org|io|dev|ai|co|edu|gov)\b/gi, " ") // stray domains (broken emails)
    .replace(/\+\d[\d\s().-]*/g, " ") // +1 609..., +44 ...
    .replace(/\(\d{3}\)[\s.-]*\d{3}[\s.-]*\d{4}/g, " ") // (xxx) xxx-xxxx
    .replace(/\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g, " ") // xxx-xxx-xxxx
    .replace(/\b\d{7,}\b/g, " "); // digit runs of 7+

const tokenize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !digitHeavy(w));

const isBad = (w) => STOPWORDS.has(w) || NOISE.has(w) || digitHeavy(w);

// Bigrams must not cross line breaks or these punctuation marks, or they glue
// unrelated words together ("science princeton" from "M.S. ... Science,
// Princeton"; "sql ctes" from "SQL (CTEs, ...)"). Split into segments first,
// then build bigrams only WITHIN a segment.
//
// CRITICAL: pair RAW adjacent tokens, stopwords included, and skip any pair
// containing a bad word. Filtering stopwords BEFORE pairing splices the
// survivors together: "end to end" → [end, end] → "end end"; "statistics and
// machine learning" → "statistics machine". With raw adjacency those emit
// nothing and "machine learning" respectively.
const SEG_SPLIT = /[\n,;:()|/•]+/;
const tokenizeRaw = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
const segmentBigrams = (text, into) => {
  for (const seg of text.split(SEG_SPLIT)) {
    const t = tokenizeRaw(seg);
    for (let i = 0; i < t.length - 1; i++) {
      const a = t[i], b = t[i + 1];
      if (isBad(a) || isBad(b)) continue;
      into(`${a} ${b}`);
    }
  }
};

/**
 * Extract weighted keywords: unigrams and bigrams by frequency, with contact
 * info, dates, and boilerplate removed. Returns [{ term, weight }] by weight.
 */
export function extractKeywords(text, max = 40) {
  const cleaned = preClean(text);
  const tokens = tokenize(cleaned);

  // Unigram occurrence counts (skip pure noise words) — unchanged: counted
  // across the whole token stream.
  const uni = new Map();
  for (const t of tokens) if (!NOISE.has(t)) uni.set(t, (uni.get(t) || 0) + 1);

  // (d) Bigram occurrence counts, built only within a segment.
  const bi = new Map();
  segmentBigrams(cleaned, (k) => bi.set(k, (bi.get(k) || 0) + 1));

  // (e) Drop the person's name. With line structure preserved, the name is
  // the first non-empty line, repeated verbatim in page headers. The old
  // heuristic (highest-count bigram in the first 120 chars) misfired badly:
  // an education line near the top ("...Statistics and Machine Learning")
  // could outcount the name, deleting "machine learning" as if it were the
  // name and keeping the actual name as a keyword. Now: drop a first-line
  // bigram only when its total count is fully explained by repeats of that
  // line — a real skill mentioned elsewhere always exceeds that and survives
  // even if the resume opens with a headline instead of a name.
  const lines = cleaned.split("\n").map((l) => l.trim());
  const firstLine = lines.find(Boolean) || "";
  const lineRepeats = lines.filter((l) => l === firstLine).length;
  const dropBigrams = new Set();
  const nameWordCounts = new Map();
  segmentBigrams(firstLine, (k) => {
    if ((bi.get(k) || 0) > lineRepeats) return; // appears beyond the header
    dropBigrams.add(k);
    const [a, b] = k.split(" ");
    nameWordCounts.set(a, (nameWordCounts.get(a) || 0) + (bi.get(k) || 0));
    nameWordCounts.set(b, (nameWordCounts.get(b) || 0) + (bi.get(k) || 0));
  });
  const dropUnigram = new Set();
  for (const [w, inName] of nameWordCounts) {
    if ((uni.get(w) || 0) <= inName) dropUnigram.add(w);
  }

  // (f) Suppress unigrams that never stand alone: if a word's count is fully
  // explained by its appearances inside kept phrases ("machine" only ever in
  // "machine learning"), the phrase carries the signal and the fragment is
  // noise. Words with standalone uses beyond their phrases survive.
  const inPhrase = new Map();
  for (const [k, c] of bi) {
    if (dropBigrams.has(k)) continue;
    const [a, b] = k.split(" ");
    inPhrase.set(a, (inPhrase.get(a) || 0) + c);
    inPhrase.set(b, (inPhrase.get(b) || 0) + c);
  }

  const counts = new Map();
  for (const [t, c] of uni) {
    if (dropUnigram.has(t)) continue;
    if (c <= (inPhrase.get(t) || 0)) continue; // phrase fragments only
    counts.set(t, c);
  }
  for (const [k, c] of bi) if (!dropBigrams.has(k)) counts.set(k, c * 2.5); // phrases discriminate more

  return [...counts.entries()]
    .filter(([, w]) => w >= 2)
    .sort((x, y) => y[1] - x[1])
    .slice(0, max)
    .map(([term, weight]) => ({ term, weight }));
}

export { tokenize };
