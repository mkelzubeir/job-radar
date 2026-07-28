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
      text += content.items.map((i) => i.str).join(" ") + "\n";
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
  `experience work team teams role company companies year years month months responsibilities skills including led built managed developed strong new key drive support ability work working email phone linkedin github university college bachelor master degree gpa january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec present current resident permanent citizen citizenship visa authorized authorization references cum laude summa magna`.split(
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

/**
 * Extract weighted keywords: unigrams and bigrams by frequency, with contact
 * info, dates, and boilerplate removed. Returns [{ term, weight }] by weight.
 */
export function extractKeywords(text, max = 40) {
  const cleaned = preClean(text);
  const tokens = tokenize(cleaned);

  // Unigram occurrence counts (skip pure noise words).
  const uni = new Map();
  for (const t of tokens) if (!NOISE.has(t)) uni.set(t, (uni.get(t) || 0) + 1);

  // (d) Bigram occurrence counts — skip when either word is noise, a stopword,
  // or digit-heavy (tokenize already dropped stopwords/digit-heavy tokens).
  const bi = new Map();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (isBad(a) || isBad(b)) continue;
    bi.set(`${a} ${b}`, (bi.get(`${a} ${b}`) || 0) + 1);
  }

  // (e) The person's name repeats in page headers and slips through as a
  // high-frequency bigram. Drop the top-frequency bigram(s) that also appear in
  // the first 120 chars of the cleaned text, plus any unigram that occurs ONLY
  // inside those bigrams.
  const headerTokens = tokenize(cleaned.slice(0, 120));
  const headerBigrams = new Set();
  for (let i = 0; i < headerTokens.length - 1; i++) {
    headerBigrams.add(`${headerTokens[i]} ${headerTokens[i + 1]}`);
  }
  const dropBigrams = new Set();
  const nameWordCounts = new Map();
  const headerEntries = [...bi.entries()].filter(([k]) => headerBigrams.has(k));
  if (headerEntries.length) {
    const maxc = Math.max(...headerEntries.map(([, c]) => c));
    for (const [k, c] of headerEntries) {
      if (c !== maxc) continue;
      dropBigrams.add(k);
      const [a, b] = k.split(" ");
      nameWordCounts.set(a, (nameWordCounts.get(a) || 0) + c);
      nameWordCounts.set(b, (nameWordCounts.get(b) || 0) + c);
    }
  }
  const dropUnigram = new Set();
  for (const [w, inName] of nameWordCounts) {
    if ((uni.get(w) || 0) <= inName) dropUnigram.add(w);
  }

  const counts = new Map();
  for (const [t, c] of uni) if (!dropUnigram.has(t)) counts.set(t, c);
  for (const [k, c] of bi) if (!dropBigrams.has(k)) counts.set(k, c * 2.5); // phrases discriminate more

  return [...counts.entries()]
    .filter(([, w]) => w >= 2)
    .sort((x, y) => y[1] - x[1])
    .slice(0, max)
    .map(([term, weight]) => ({ term, weight }));
}

export { tokenize };
