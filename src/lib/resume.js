/**
 * Resume parsing — runs entirely in the browser.
 * PDF text extraction uses pdf.js; .txt/.md are read directly.
 * The resume never leaves the user's machine.
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

// Generic resume words that match every job description and add noise.
const NOISE = new Set(
  `experience work team teams role company companies year years month months responsibilities skills including led built managed developed strong new key drive support ability work working email phone linkedin github university college bachelor master degree gpa january february march april may june july august september october november december`.split(
    " "
  )
);

const tokenize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

/**
 * Extract weighted keywords: unigrams and bigrams by frequency,
 * with noise terms removed. Returns [{ term, weight }] sorted by weight.
 */
export function extractKeywords(text, max = 40) {
  const tokens = tokenize(text);
  const counts = new Map();
  const bump = (term, w) => counts.set(term, (counts.get(term) || 0) + w);

  tokens.forEach((t) => {
    if (!NOISE.has(t)) bump(t, 1);
  });
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (NOISE.has(a) || NOISE.has(b)) continue;
    bump(`${a} ${b}`, 2.5); // phrases are far more discriminative
  }

  return [...counts.entries()]
    .filter(([, w]) => w >= 2)
    .sort((x, y) => y[1] - x[1])
    .slice(0, max)
    .map(([term, weight]) => ({ term, weight }));
}

export { tokenize };
