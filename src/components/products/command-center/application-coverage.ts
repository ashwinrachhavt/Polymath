export function keywordCoverage(text: string, rawKeywords: string) {
  const keywords = [...new Set(rawKeywords.split(/[,\n]/).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))];
  if (keywords.length > 50 || keywords.some((keyword) => keyword.length > 80)) return { error: "Use at most 50 keywords, each at most 80 characters.", matched: [], missing: [] };
  const content = text.toLocaleLowerCase();
  return { error: "", matched: keywords.filter((keyword) => content.includes(keyword)), missing: keywords.filter((keyword) => !content.includes(keyword)) };
}
