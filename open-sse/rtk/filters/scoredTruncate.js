// Importance-scored truncation: keeps high-value lines from the middle
// instead of blindly cutting everything between head and tail.
// Replaces smart-truncate as the final RTK fallback for unstructured blobs.
import { SCORED_HEAD, SCORED_TAIL, SCORED_MIN_LINES, SCORED_THRESHOLD, SCORED_MAX_KEEP } from "../constants.js";

const RE_ERROR = /\b(error|fail|exception|assert|traceback|panic|fatal|crash)\b|❌|✗|✘/i;
const RE_STACK = /^\s+(at\s+|File "|#\d+\s)/m;
const RE_RESULT = /\d+%\s|passing|failing|✓|✔|passed|failed|\b\d+\/\d+\b/i;
const RE_PATH_URL = /https?:\/\/|[\/\\]\w+\.\w{2,4}/;
const RE_SEPARATOR = /^[-=*_~]{3,}$|^\s*#{1,3}\s/m;
const RE_JSON_KEY = /"\w+"\s*:\s*[^\[{[]/;
const RE_NOISE = /^\s*(console\.|print\(|log\(|\/\/|\/\*|\*\/|#\s)/;

function scoreLine(line, prevTrimmed) {
  const trimmed = line.trim();
  if (!trimmed) return -2;
  let score = 0;
  if (RE_ERROR.test(trimmed)) score += 5;
  if (RE_STACK.test(line)) score += 3;
  if (RE_RESULT.test(trimmed)) score += 2;
  if (RE_PATH_URL.test(trimmed)) score += 2;
  if (RE_SEPARATOR.test(trimmed)) score += 1;
  if (RE_JSON_KEY.test(trimmed)) score += 1;
  if (RE_NOISE.test(trimmed)) score -= 1;
  if (prevTrimmed && trimmed === prevTrimmed) score -= 4;
  return score;
}

function compressMiddle(middle, threshold, head, tail) {
  const kept = [];
  let omitted = 0;
  let prevTrimmed = null;
  for (const line of middle) {
    const s = scoreLine(line, prevTrimmed);
    if (s >= threshold) {
      if (omitted > 0) { kept.push(`... +${omitted} lines omitted`); omitted = 0; }
      kept.push(line);
    } else {
      omitted++;
    }
    prevTrimmed = line.trim();
  }
  if (omitted > 0) kept.push(`... +${omitted} lines omitted`);
  return [...head, ...kept, ...tail];
}

export function scoredTruncate(input) {
  const lines = input.split("\n");
  if (lines.length < SCORED_MIN_LINES) return input;

  const head = lines.slice(0, SCORED_HEAD);
  const tail = lines.slice(lines.length - SCORED_TAIL);
  const middle = lines.slice(SCORED_HEAD, lines.length - SCORED_TAIL);

  let threshold = SCORED_THRESHOLD;
  let result = compressMiddle(middle, threshold, head, tail);

  // Escalate threshold if still too long
  while (result.length > SCORED_MAX_KEEP && threshold < 10) {
    threshold += 2;
    result = compressMiddle(middle, threshold, head, tail);
  }

  return result.join("\n");
}

scoredTruncate.filterName = "scored-truncate";
